// ==============================================================================
// Mutation reports
// ==============================================================================
// Freshness, merging and scoring of Stryker reports, shared by the scoped and
// full mutation jobs in node-quality-gates.yml. The jobs check this file out at
// the workflow's own commit, so callers need nothing extra.
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RANGE = /^(.*?):((\d+)(?::(\d+))?-(\d+)(?::(\d+))?)$/;

export const normalise = (file, cwd = process.cwd()) =>
    path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');

export const testKey = (file, test) => {
    const start = test.location?.start ?? { line: 0, column: 0 };
    return `${file}@${start.line}:${start.column}\n${test.name}`;
};

export const mutantKey = (file, { mutatorName, replacement, location: { start, end } }) =>
    `${file}@${start.line}:${start.column}-${end.line}:${end.column}\n${mutatorName}: ${replacement}`;

const atOrAfter = (a, b) => a.line > b.line || (a.line === b.line && a.column >= b.column);

// Report columns are one-based; Stryker reads range columns as zero-based.
const inRange = ({ start, end }, range) =>
    atOrAfter({ line: start.line, column: start.column - 1 }, range.start)
    && atOrAfter(range.end, { line: end.line, column: end.column - 1 });

// The plans escape magic characters as one-character classes for Stryker.
export const unescape = (file) => file.replace(/^\.\/!/, '!').replace(/\[([?*()[\]{}])\]/g, '$1');

export const escape = (file) => file.replace(/^!/, './!').replace(/[?*()[\]{}]/g, '[$&]');

// A --mutate list as each file mapped to true (the whole file) or its line ranges.
export function parseScope(mutate) {
    const scope = new Map();
    for (const entry of mutate.split(',').filter(Boolean)) {
        const range = RANGE.exec(entry);
        const file = normalise(unescape(range ? range[1] : entry));
        const current = scope.get(file);
        if (!range) {
            scope.set(file, true);
        } else if (current !== true) {
            scope.set(file, [...(current ?? []), {
                start: { line: Number(range[3]), column: Number(range[4] ?? 0) },
                end: { line: Number(range[5]), column: Number(range[6] ?? Infinity) },
            }]);
        }
    }
    return scope;
}

export const inScope = (scope, file, { location }) => {
    const ranges = scope?.get(normalise(file));
    return ranges === true || (Array.isArray(ranges) && ranges.some((range) => inRange(location, range)));
};

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isReport = (report) => isObject(report) && isObject(report.files)
    && Object.values(report.files).every((result) => isObject(result)
        && (result.mutants === undefined || Array.isArray(result.mutants)));

// The report only when Stryker wrote it after the marker, so a restored or truncated one never counts.
export function readFresh(reportPath, markerPath) {
    try {
        if (fs.statSync(reportPath).mtimeMs <= fs.statSync(markerPath).mtimeMs) {
            return null;
        }
    } catch {
        return null;
    }
    const report = readJson(reportPath);
    return isReport(report) ? report : null;
}

// Why a report cannot stand for its shard: mutants left untested, or files outside the shard's scope.
export function reportProblems(report, scope) {
    const problems = [];
    for (const [file, result] of Object.entries(report.files)) {
        if (scope && !scope.has(normalise(file))) {
            problems.push(`reports ${file}, which is outside its scope`);
        }
        const untested = (result.mutants ?? []).filter(({ status }) => !status || status === 'Pending').length;
        if (untested > 0) {
            problems.push(`has ${untested} untested mutant(s) in ${file}`);
        }
    }
    return problems;
}

// Each planned shard's artifact, as { shard, locate, read }. A shard with no artifact is missing, never skipped.
// An artifact whose files all sit under reports/ is stored without that folder, and a lone matching artifact
// is extracted straight into the folder, with only its record, if any, to name its shard.
export function collectShards(dir, prefix, shards, recordName) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {}
    const locate = (base, name) =>
        [path.join(base, 'reports', name), path.join(base, name)].find((file) => fs.existsSync(file)) ?? null;
    const entry = (shard, base) => ({
        shard,
        locate: (name) => locate(base, name),
        read: (name) => {
            const file = locate(base, name);
            return file && readJson(file);
        },
    });
    const found = new Map();
    const isDir = (name) => {
        try {
            return fs.statSync(path.join(dir, name)).isDirectory();
        } catch {
            return false;
        }
    };
    if (names.some((name) => name.startsWith(prefix) && isDir(name))) {
        for (const shard of shards) {
            const base = path.join(dir, `${prefix}${shard}`);
            if (fs.existsSync(base)) {
                found.set(shard, entry(shard, base));
            }
        }
    } else if (names.length > 0) {
        const record = recordName ? entry(null, dir).read(recordName) : null;
        const named = record?.shard;
        const shard = named === undefined ? (shards.length === 1 ? shards[0] : null) : named;
        found.set(shard, entry(shard, dir));
    }
    const missing = shards.filter((shard) => !found.has(shard));
    return { found: [...found.values()], missing };
}

// Unions reports by mutant and test key. A shard's own scope wins over carried copies, and a carried copy its
// owner no longer reports is dropped as a mutant the code no longer has.
export function mergeReports(entries, scopes) {
    const owns = (shard, file, mutant) => inScope(scopes.get(shard), file, mutant);

    const tests = new Map();
    const testFiles = {};
    const idMaps = entries.map(({ report }) => {
        const ids = new Map();
        for (const [file, testFile] of Object.entries(report.testFiles ?? {})) {
            testFiles[file] ??= { ...testFile, tests: [] };
            for (const test of testFile.tests ?? []) {
                const key = testKey(file, test);
                if (!tests.has(key)) {
                    tests.set(key, String(tests.size));
                    testFiles[file].tests.push({ ...test, id: tests.get(key) });
                }
                ids.set(test.id, tests.get(key));
            }
        }
        return ids;
    });

    const chosen = new Map();
    entries.forEach(({ shard, report }, index) => {
        for (const [file, result] of Object.entries(report.files ?? {})) {
            const entry = chosen.get(normalise(file)) ?? { result: null, owned: false, mutants: new Map() };
            const owner = scopes.get(shard)?.has(normalise(file)) ?? false;
            if (entry.result === null || (owner && !entry.owned)) {
                entry.result = result;
                entry.owned = owner;
            }
            for (const mutant of result.mutants ?? []) {
                const key = mutantKey(normalise(file), mutant);
                const current = entry.mutants.get(key);
                const owned = owns(shard, file, mutant);
                if (!current || (!current.owned && owned)) {
                    entry.mutants.set(key, { mutant, owned, ids: idMaps[index] });
                }
            }
            chosen.set(normalise(file), entry);
        }
    });

    const owners = entries.map(({ shard }) => shard).filter((shard) => shard !== null);
    let stale = 0;
    for (const [file, entry] of chosen) {
        for (const [key, { mutant, owned }] of entry.mutants) {
            if (!owned && owners.some((shard) => owns(shard, file, mutant))) {
                entry.mutants.delete(key);
                stale++;
            }
        }
        if (entry.mutants.size === 0 && !entry.owned && owners.some((shard) =>
            scopes.get(shard)?.get(normalise(file)) === true)) {
            chosen.delete(file);
        }
    }

    let count = 0;
    const remap = (ids, list) => list?.map((id) => ids.get(id)).filter((id) => id !== undefined);
    const files = {};
    for (const [file, { result, mutants }] of chosen) {
        files[file] = {
            ...result,
            mutants: [...mutants.values()].map(({ mutant, ids }) => ({
                ...mutant,
                id: String(count++),
                killedBy: remap(ids, mutant.killedBy),
                coveredBy: remap(ids, mutant.coveredBy),
            })),
        };
    }

    const report = { ...entries[0].report, files };
    if (entries.some(({ report: each }) => each.testFiles)) {
        report.testFiles = testFiles;
    }
    return { report, files: chosen.size, mutants: count, stale };
}

// Stryker's own copies of its report packages, so a caller's hoisting cannot change the numbers.
function fromStryker(cwd) {
    const core = createRequire(path.join(cwd, 'package.json')).resolve('@stryker-mutator/core/package.json');
    return createRequire(core);
}

// The score as Stryker computes it: a timeout counts as detected, and with nothing counted it is NaN.
export async function scoreReport(report, cwd = process.cwd()) {
    const metricsModule = fromStryker(cwd).resolve('mutation-testing-metrics');
    const { calculateMutationTestMetrics } = await import(pathToFileURL(metricsModule).href);
    const { metrics } = calculateMutationTestMetrics(report).systemUnderTestMetrics;
    return {
        score: metrics.mutationScore,
        detected: metrics.totalDetected,
        timedOut: metrics.timeout,
        undetected: metrics.totalUndetected,
        counted: metrics.totalValid,
    };
}

// As in Stryker: no number to break on, or no score, never breaks.
export const breaks = (score, threshold) => typeof threshold === 'number' && score < threshold;

export function undetectedLines(report) {
    const lines = [];
    for (const [file, result] of Object.entries(report.files)) {
        for (const mutant of result.mutants ?? []) {
            if (['Survived', 'NoCoverage'].includes(mutant.status)) {
                const replacement = String(mutant.replacement ?? '').replace(/\s+/g, ' ').slice(0, 80);
                const { line, column } = mutant.location.start;
                const { status, mutatorName } = mutant;
                lines.push(`${normalise(file)}:${line}:${column} ${status} ${mutatorName} ${replacement}`);
            }
        }
    }
    return lines;
}

// The same page Stryker's HTML reporter writes, built from its own copy of the report elements.
export function renderHtml(report, cwd = process.cwd()) {
    const elements = fromStryker(cwd).resolve('mutation-testing-elements/dist/mutation-test-elements.js');
    const script = fs.readFileSync(elements, 'utf8');
    const json = JSON.stringify(report).replace(/</g, '<"+"');
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script>
        ${script}
    </script>
</head>
<body>
    <mutation-test-report-app titlePostfix="Stryker"></mutation-test-report-app>
    <script>
        const app = document.querySelector('mutation-test-report-app');
        app.report = ${json};
    </script>
</body>
</html>
`;
}

// Each test's cost as the number of mutants it covers against the average test's: a test that drives the whole
// application runs far longer than one that drives a single function, and the report records no test times.
export function testCosts(report) {
    const covers = new Map();
    for (const result of Object.values(report.files ?? {})) {
        for (const mutant of result.mutants ?? []) {
            for (const id of mutant.coveredBy ?? []) {
                covers.set(id, (covers.get(id) ?? 0) + 1);
            }
        }
    }
    const mean = [...covers.values()].reduce((sum, count) => sum + count, 0) / covers.size;
    return new Map([...covers].map(([id, count]) => [id, count / mean]));
}

// Weighs a mutant by the cost of the tests it ran, plus one for the run itself. A static mutant runs every
// test, so each counts as the average.
export function mutantWeight(mutant, costs = new Map()) {
    const covering = mutant.coveredBy ?? [];
    const each = mutant.static || covering.length === 0
        ? 1
        : covering.reduce((sum, id) => sum + (costs.get(id) ?? 1), 0) / covering.length;
    return 1 + (mutant.testsCompleted ?? covering.length) * each;
}

// Seconds per file and per mutated line for the next plans, each shard's measured time shared out by the
// weight of its own mutants. Lines are [line, mutants, seconds], by the line each mutant starts on.
export function measureSweep(report, shards) {
    const costs = testCosts(report);
    const files = {};
    const lines = {};
    for (const { scope, seconds } of shards) {
        const time = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        const weighed = [];
        for (const [file, result] of Object.entries(report.files)) {
            for (const mutant of result.mutants ?? []) {
                if (inScope(scope, file, mutant)) {
                    weighed.push({ file: normalise(file), mutant, weight: mutantWeight(mutant, costs) });
                }
            }
        }
        const total = weighed.reduce((sum, { weight }) => sum + weight, 0);
        for (const file of scope.keys()) {
            files[file] = (files[file] ?? 0) + (total > 0 ? 0 : time / scope.size);
        }
        for (const { file, mutant, weight } of total > 0 ? weighed : []) {
            const share = (weight / total) * time;
            const line = mutant.location.start.line;
            files[file] += share;
            lines[file] ??= new Map();
            const [count, sum] = lines[file].get(line) ?? [0, 0];
            lines[file].set(line, [count + 1, sum + share]);
        }
    }
    const listed = Object.fromEntries(Object.entries(lines).map(([file, byLine]) => [file, [...byLine]
        .sort(([a], [b]) => a - b)
        .map(([line, [count, sum]]) => [line, count, Math.round(sum * 1000) / 1000])]));
    return { files, lines: listed };
}

const isSeconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Estimated seconds for each scope entry ({ path, range, start, end }) from the last full sweep, or null when
// there is no usable sweep. A measured file costs what it took; a range costs the larger of what its lines took
// and the file's average per line, so code added since the sweep still counts; a file the sweep never saw costs
// the sweep's average per line. `lineCount` gives a file's lines, or null when it is gone.
export function estimateScope(entries, history, lineCount) {
    const files = isObject(history?.files) ? history.files : {};
    let seconds = 0;
    let total = 0;
    for (const [file, time] of Object.entries(files)) {
        const count = isSeconds(time) ? lineCount(file) : null;
        if (count > 0) {
            seconds += time;
            total += count;
        }
    }
    if (total === 0) {
        return null;
    }
    const recorded = (file, start, end) => {
        const lines = isObject(history.lines) && Array.isArray(history.lines[file]) ? history.lines[file] : [];
        return lines.reduce((sum, line) => (Array.isArray(line) && line[0] >= start && line[0] <= end
            && isSeconds(line[2]) ? sum + line[2] : sum), 0);
    };
    const costs = entries.map(({ path: file, range, start, end }) => {
        const count = lineCount(file) || 1;
        const size = range ? end - start + 1 : count;
        if (!isSeconds(files[file])) {
            return size * (seconds / total);
        }
        if (!range) {
            return files[file];
        }
        return Math.max(recorded(file, start, end), size * (files[file] / count));
    });
    return costs.every(Number.isFinite) && Number.isFinite(costs.reduce((sum, cost) => sum + cost, 0)) ? costs : null;
}

const disjoint = (entries) => entries.every(({ range }) => range) && [...entries]
    .sort((a, b) => a.start - b.start)
    .every((entry, index, sorted) => index === 0 || entry.start > sorted[index - 1].end);

// Packs units ({ key, weight }), heaviest first, onto the least loaded of `count` shards.
export function pack(units, count) {
    const sorted = [...units].sort((a, b) => b.weight - a.weight || compare(a.key, b.key));
    const bins = Array.from({ length: Math.min(count, sorted.length) }, () => ({ weight: 0, units: [] }));
    for (const unit of sorted) {
        const bin = bins.reduce((least, other) => (other.weight < least.weight
            || (other.weight === least.weight && other.units.length < least.units.length) ? other : least));
        bin.weight += unit.weight;
        bin.units.push(unit);
    }
    return bins;
}

// Splits scope entries ({ path, text, range, start, end }) into at most `count` shards by their weights. A file
// heavier than a shard's fair share is split by its ranges when no two overlap, so no mutant runs on two shards;
// a range is never cut.
export function planScope(entries, weights, count) {
    const byPath = new Map();
    entries.forEach((entry, index) => {
        byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), { entry, weight: weights[index] }]);
    });
    const weigh = (items) => items.reduce((sum, { weight }) => sum + weight, 0);
    const total = weigh([...byPath.values()].flat());
    const units = [...byPath.keys()].sort(compare).flatMap((file) => {
        const items = byPath.get(file);
        return weigh(items) > total / count && items.length > 1 && disjoint(items.map(({ entry }) => entry))
            ? items.map(({ entry, weight }) => ({ key: entry.text, weight, entries: [entry] }))
            : [{ key: file, weight: weigh(items), entries: items.map(({ entry }) => entry) }];
    });
    return pack(units, count).map((bin) => ({
        weight: bin.weight,
        entries: bin.units.flatMap((unit) => unit.entries)
            .sort((a, b) => compare(a.path, b.path) || a.start - b.start),
    }));
}

// Stryker's `mutate` patterns as the files on disk they select, in order, as Stryker reads them: a later `!`
// pattern drops files, and a line range keeps its whole file, since the full sweep never splits one.
export function expandMutate(patterns, cwd = process.cwd()) {
    const skip = (entry) => /(^|[\\/])(node_modules|\.git)$/.test(typeof entry === 'string' ? entry : entry.name);
    const selected = new Set();
    for (const raw of patterns) {
        const text = String(raw).trim();
        if (text === '') {
            continue;
        }
        const negated = text.startsWith('!');
        const body = negated ? text.slice(1) : text;
        const pattern = RANGE.exec(body)?.[1] ?? body;
        if (negated) {
            for (const file of selected) {
                if (path.matchesGlob(file, normalise(pattern, cwd))) {
                    selected.delete(file);
                }
            }
            continue;
        }
        for (const file of fs.globSync(pattern, { cwd, exclude: skip })) {
            const name = normalise(file, cwd);
            try {
                if (fs.statSync(path.join(cwd, name)).isFile()) {
                    selected.add(name);
                }
            } catch {}
        }
    }
    return [...selected].sort();
}

// Packs whole files, heaviest first, onto the least loaded of `count` shards.
export const packFiles = (weights, count) => pack([...weights].map(([key, weight]) => ({ key, weight })), count)
    .map((bin) => ({ weight: bin.weight, files: bin.units.map(({ key }) => key).sort(compare) }));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'fresh') {
        process.exit(readFresh(args[0], args[1]) ? 0 : 1);
    }
    console.error(`Unknown command '${command}'.`);
    process.exit(2);
}
