import { promises as fs } from 'fs';
// import {readFileSync} from "fs";
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
	readTime: number;
	preprocessTime: number;
	compileTime: number;
	start: number;
	end: number;
}

function duration(timestamps: TimeStamp[], to: string, from?: string): number {
	const toIndex = timestamps.findIndex((t) => t.event === to);
	const fromIndex = from ? timestamps.findIndex((t) => t.event === from) : toIndex - 1;
	return timestamps[toIndex].ts - timestamps[fromIndex].ts;
}
function eventTS(timestamps: TimeStamp[], event: string): number {
	return timestamps.find((t) => t.event === event).ts;
}
function humanDuration(n: number) {
	return n < 10 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(3)}s`;
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
			build.onStart(() => {
				stats.length = 0;
				bundleStart = performance.now();
			});

			build.onLoad({ filter: svelteFilter }, async ({ path: filename }) => {
				const timestamps: { event: string; ts: number }[] = [];
				const takeTimestamp = (event: string) => {
					timestamps.push({ event, ts: performance.now() });
				};
				takeTimestamp('start');

				// TODO readFileSync reads the file itself more efficiently, but blocks. which one is faster?
				//const code = readFileSync(filename,'utf-8')
				const code = await fs.readFile(filename, 'utf8');
				takeTimestamp('read');
				try {
					const contents = await compileSvelte(options, { filename, code }, takeTimestamp);
					takeTimestamp('end');
					stats.push({ filename, timestamps });
					return { contents };
				} catch (e) {
					return { errors: [toESBuildError(e, options)] };
				}
			});

			build.onEnd(async () => {
				const totalDuration = performance.now() - bundleStart;
				// find package jsons
				await Promise.all(
					stats.map((stat) => findClosestPkgJsonPath(stat.filename).then((pkg) => (stat.pkg = pkg)))
				);
				// group stats
				const grouped: { [key: string]: GroupStat } = {};
				stats.forEach((stat) => {
					const readTime = duration(stat.timestamps, 'read');
					const preprocessTime = duration(stat.timestamps, 'preprocessed');
					const compileTime = duration(stat.timestamps, 'compiled');
					const start = eventTS(stat.timestamps, 'start');
					const end = eventTS(stat.timestamps, 'end');

					if (!grouped[stat.pkg]) {
						grouped[stat.pkg] = {
							start,
							end,
							count: 1,
							readTime,
							preprocessTime,
							compileTime,
							pkg: stat.pkg
						};
					} else {
						const group = grouped[stat.pkg];
						group.count += 1;
						group.readTime += readTime;
						group.preprocessTime += preprocessTime;
						group.compileTime += compileTime;

						if (group.start > start) {
							group.start = start;
						}
						if (group.end < end) {
							group.end = end;
						}
					}
				});
				for (const groupStat of Object.values(grouped)) {
					let name = JSON.parse(await fs.readFile(groupStat.pkg, 'utf-8')).name;
					if (!name) {
						name = groupStat.pkg;
					}

					const dur = groupStat.end - groupStat.start;
					const durAvg = dur / groupStat.count;
					const readTime = groupStat.readTime;
					const preprocessTime = groupStat.preprocessTime;
					const preprocessTimeAvg = groupStat.preprocessTime / groupStat.count;
					const readTimeAvg = groupStat.readTime / groupStat.count;
					const compileTime = groupStat.compileTime;
					const compileAvg = groupStat.compileTime / groupStat.count;
					const outputs = {
						Files: `${groupStat.count}`,
						Duration: humanDuration(dur),
						DurationAvg: humanDuration(durAvg),
						ReadTime: humanDuration(readTime),
						ReadTimeAvg: humanDuration(readTimeAvg),
						PreprocessTime: humanDuration(preprocessTime),
						PreprocessTimeAvg: humanDuration(preprocessTimeAvg),
						CompileTime: humanDuration(compileTime),
						CompileTimeAvg: humanDuration(compileAvg)
					};
					const keyLen =
						Object.keys(outputs).reduce((len, key) => (key.length > len ? key.length : len), 0) + 1;
					const valueLen = Object.values(outputs).reduce(
						(len, value) => (value.length > len ? value.length : len),
						0
					);

					log.warn(
						`prebundling stats for ${name}: ${Object.entries(outputs)
							.map(([k, v]) => `\n - ${`${k}:`.padEnd(keyLen, ' ')}${v.padStart(valueLen, ' ')}`)
							.join('')}`
					);
				}
				log.warn(`total duration: ${humanDuration(totalDuration)}`);
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
			takeTimestamp('preprocessedStart');
			preprocessed = await preprocess(code, options.preprocess, { filename });
			takeTimestamp('preprocessed');
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
