import { readFileSync } from 'fs';
import { compile, preprocess } from 'svelte/compiler';
import { DepOptimizationOptions } from 'vite';
import { Compiled } from './compile';
import { log } from './log';
import { CompileOptions, ResolvedOptions } from './options';
import { toESBuildError } from './error';
import { atLeastSvelte } from './svelte-version';
// eslint-disable-next-line node/no-missing-import
import { findClosestPkgJsonPath } from 'vitefu';

type EsbuildOptions = NonNullable<DepOptimizationOptions['esbuildOptions']>;
type EsbuildPlugin = NonNullable<EsbuildOptions['plugins']>[number];
const isCssString = atLeastSvelte('3.53.0');

export const facadeEsbuildSveltePluginName = 'vite-plugin-svelte:facade';

interface TimeStamp {
	event: string;
	ts: number;
}
interface FileStat {
	filename: string;
	pkg?: string;
	timestamps: TimeStamp[];
}
interface GroupStat {
	pkg: string;
	count: number;
	compileTime: number;
}

function duration(timestamps: TimeStamp[], to: string, from?: string): number {
	const toIndex = timestamps.findIndex((t) => t.event === to);
	const fromIndex = from ? timestamps.findIndex((t) => t.event === from) : toIndex - 1;
	return timestamps[toIndex].ts - timestamps[fromIndex].ts;
}

function humanDuration(n: number) {
	// 99.9ms  0.10s
	return n < 100 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(2)}s`;
}

export function esbuildSveltePlugin(options: ResolvedOptions): EsbuildPlugin {
	return {
		name: 'vite-plugin-svelte:optimize-svelte',
		setup(build) {
			// Skip in scanning phase as Vite already handles scanning Svelte files.
			// Otherwise this would heavily slow down the scanning phase.
			if (build.initialOptions.plugins?.some((v) => v.name === 'vite:dep-scan')) return;

			const svelteExtensions = (options.extensions ?? ['.svelte']).map((ext) => ext.slice(1));
			const svelteFilter = new RegExp(`\\.(` + svelteExtensions.join('|') + `)(\\?.*)?$`);
			const stats: FileStat[] = [];
			let bundleStart: number;
			const progressDelay = 2000;
			const progressThrottle = 200;
			let lastProgressLog = 0;
			const logProgress = (done = false) => {
				const now = performance.now();
				if (
					done ||
					now - (lastProgressLog || bundleStart) >
						(lastProgressLog ? progressThrottle : progressDelay)
				) {
					lastProgressLog = now;
					log.info.progress(
						`prebundling svelte dependencies - files:${`${stats.length}`.padStart(
							5,
							' '
						)} duration:${`${humanDuration(now - bundleStart)}`.padStart(7, ' ')}${
							done ? ' - done' : ''
						}`,
						done
					);
				}
			};

			const logStats = async () => {
				// find package jsons

				await Promise.all(
					stats.map((stat) => findClosestPkgJsonPath(stat.filename).then((pkg) => (stat.pkg = pkg)))
				);
				if (stats.length === 1) {
					const stat = stats[0];
					const libname = JSON.parse(readFileSync(stat.pkg, 'utf-8')).name;
					const importString = stat.filename.slice(stat.filename.lastIndexOf(`/${libname}/`) + 1);
					const componentName = importString.slice(
						importString.lastIndexOf('/') + 1,
						importString.lastIndexOf('.')
					);
					log.warn.once(
						`prebundled ${importString}. Change the import to \`import {${componentName}} from '${libname}'\` or add ${libname} to optimizeDeps.exclude.`
					);
					return;
				}
				// group stats
				const grouped: { [key: string]: GroupStat } = {};
				stats.forEach((stat) => {
					const compileTime = duration(stat.timestamps, 'compiled');
					if (!grouped[stat.pkg]) {
						const name = JSON.parse(readFileSync(stat.pkg, 'utf-8')).name;
						grouped[stat.pkg] = {
							count: 1,
							compileTime,
							pkg: name ?? stat.pkg
						};
					} else {
						const group = grouped[stat.pkg];
						group.count += 1;
						group.compileTime += compileTime;
					}
				});

				const groups = Object.values(grouped);
				groups.sort((a, b) => b.count - a.count);
				const statLines = groups.map((groupStat) => {
					const compileTime = groupStat.compileTime;
					const compileAvg = groupStat.compileTime / groupStat.count;
					return [
						groupStat.pkg,
						`${groupStat.count}`,
						humanDuration(compileTime),
						humanDuration(compileAvg)
					];
				});
				statLines.unshift(['library', 'files', 'time', 'avg']);
				const columnWidths = statLines.reduce(
					(widths: number[], row) => {
						for (let i = 0; i < row.length; i++) {
							const cell = row[i];
							if (widths[i] < cell.length) {
								widths[i] = cell.length;
							}
						}
						return widths;
					},
					statLines[0].map(() => 0)
				);

				const table = statLines
					.map((row) =>
						row
							.map((cell, i) => {
								if (i === 0) {
									return cell.padEnd(columnWidths[i], ' ');
								} else {
									return cell.padStart(columnWidths[i], ' ');
								}
							})
							.join('\t')
					)
					.join('\n');
				log.info('prebundling compile stats', table);
			};

			build.onStart(() => {
				stats.length = 0;
				bundleStart = performance.now();
				lastProgressLog = 0;
			});

			build.onLoad({ filter: svelteFilter }, async ({ path: filename }) => {
				const timestamps: { event: string; ts: number }[] = [];
				const takeTimestamp = (event: string) => {
					timestamps.push({ event, ts: performance.now() });
				};
				logProgress();
				const code = readFileSync(filename, 'utf-8');
				try {
					const contents = await compileSvelte(options, { filename, code }, takeTimestamp);
					stats.push({ filename, timestamps });
					return { contents };
				} catch (e) {
					return { errors: [toESBuildError(e, options)] };
				}
			});

			build.onEnd(async () => {
				logProgress(true);
				await logStats();
			});
		}
	};
}

async function compileSvelte(
	options: ResolvedOptions,
	{ filename, code }: { filename: string; code: string },
	// eslint-disable-next-line no-unused-vars
	takeTimestamp: (event: string) => void
): Promise<string> {
	let css = options.compilerOptions.css;
	if (css !== 'none') {
		css = isCssString ? 'injected' : true;
	}
	const compileOptions: CompileOptions = {
		...options.compilerOptions,
		css,
		filename,
		format: 'esm',
		generate: 'dom'
	};

	let preprocessed;

	if (options.preprocess) {
		try {
			preprocessed = await preprocess(code, options.preprocess, { filename });
		} catch (e) {
			e.message = `Error while preprocessing ${filename}${e.message ? ` - ${e.message}` : ''}`;
			throw e;
		}
		if (preprocessed.map) compileOptions.sourcemap = preprocessed.map;
	}

	const finalCode = preprocessed ? preprocessed.code : code;

	const dynamicCompileOptions = await options.experimental?.dynamicCompileOptions?.({
		filename,
		code: finalCode,
		compileOptions
	});

	if (dynamicCompileOptions && log.debug.enabled) {
		log.debug(`dynamic compile options for  ${filename}: ${JSON.stringify(dynamicCompileOptions)}`);
	}

	const finalCompileOptions = dynamicCompileOptions
		? {
				...compileOptions,
				...dynamicCompileOptions
		  }
		: compileOptions;
	takeTimestamp('compileStart');
	const compiled = compile(finalCode, finalCompileOptions) as Compiled;
	takeTimestamp('compiled');
	return compiled.js.code + '//# sourceMappingURL=' + compiled.js.map.toUrl();
}
