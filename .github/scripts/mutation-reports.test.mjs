import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
    breaks,
    collectShards,
    escape,
    estimateScope,
    expandMutate,
    inScope,
    measureSweep,
    mergeReports,
    mutantWeight,
    packFiles,
    parseScope,
    planScope,
    readFresh,
    reportProblems,
    scoreReport,
    testCosts,
} from './mutation-reports.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-reports-'));
const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const at = (line, column = 1, endLine = line, endColumn = column + 4) =>
    ({ start: { line, column }, end: { line: endLine, column: endColumn } });
const mutant = (line, status, extra = {}) =>
    ({ id: String(line), mutatorName: 'Test', replacement: `r${line}`, location: at(line), status, ...extra });
const report = (files, testFiles) => ({
    schemaVersion: '2',
    thresholds: { high: 80, low: 60, break: 50 },
    files: Object.fromEntries(Object.entries(files)
        .map(([file, mutants]) => [file, { language: 'typescript', source: '', mutants }])),
    ...(testFiles ? { testFiles } : {}),
});

describe('readFresh', () => {
    it('reads a report written after the marker', () => {
        const dir = temp();
        write(path.join(dir, 'marker'), '');
        write(path.join(dir, 'report.json'), report({ 'a.ts': [] }));
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(dir, 'marker'), past, past);
        assert.deepEqual(Object.keys(readFresh(path.join(dir, 'report.json'), path.join(dir, 'marker')).files),
            ['a.ts']);
    });

    it('rejects a report older than the marker, a broken one and a missing one', () => {
        const dir = temp();
        write(path.join(dir, 'report.json'), report({}));
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(dir, 'report.json'), past, past);
        write(path.join(dir, 'marker'), '');
        assert.equal(readFresh(path.join(dir, 'report.json'), path.join(dir, 'marker')), null);

        write(path.join(dir, 'broken.json'), '{"files":');
        fs.utimesSync(path.join(dir, 'marker'), past, new Date(Date.now() - 120_000));
        assert.equal(readFresh(path.join(dir, 'broken.json'), path.join(dir, 'marker')), null);
        assert.equal(readFresh(path.join(dir, 'missing.json'), path.join(dir, 'marker')), null);

        for (const content of [{ files: [] }, { files: { 'a.ts': null } }, { files: { 'a.ts': { mutants: {} } } }]) {
            write(path.join(dir, 'odd.json'), content);
            assert.equal(readFresh(path.join(dir, 'odd.json'), path.join(dir, 'marker')), null);
        }
    });
});

describe('parseScope', () => {
    it('keeps whole files and ranges, and undoes the plan escaping', () => {
        const scope = parseScope(`${escape('src/[id].ts')},src/b.ts:10-20,src/b.ts:30:2-31`);
        assert.equal(scope.get('src/[id].ts'), true);
        assert.equal(scope.get('src/b.ts').length, 2);
        assert.ok(inScope(scope, 'src/b.ts', mutant(15)));
        assert.ok(!inScope(scope, 'src/b.ts', mutant(25)));
        assert.ok(inScope(scope, 'src/[id].ts', mutant(999)));
        assert.ok(!inScope(scope, 'src/c.ts', mutant(1)));
    });
});

describe('reportProblems', () => {
    it('names files outside the scope and untested mutants', () => {
        const problems = reportProblems(report({
            'a.ts': [mutant(1, 'Killed'), mutant(2, 'Pending'), mutant(3, undefined)],
            'b.ts': [mutant(1, 'Survived')],
        }), parseScope('a.ts'));
        assert.deepEqual(problems, ['has 2 untested mutant(s) in a.ts', 'reports b.ts, which is outside its scope']);
    });
});

describe('collectShards', () => {
    it('finds each shard folder and reports the missing ones', () => {
        const dir = temp();
        write(path.join(dir, 'shard-1', 'stryker.json'), report({}));
        write(path.join(dir, 'shard-3', 'reports', 'stryker.json'), report({}));
        const { found, missing } = collectShards(dir, 'shard-', [1, 2, 3]);
        assert.deepEqual(found.map(({ shard }) => shard), [1, 3]);
        assert.deepEqual(missing, [2]);
        assert.ok(found[1].read('stryker.json').files);
        assert.equal(found[0].read('absent.json'), null);
    });

    it('names a lone extracted artifact by its record', () => {
        const dir = temp();
        write(path.join(dir, 'record.json'), { shard: 2 });
        const { found, missing } = collectShards(dir, 'shard-', [1, 2], 'record.json');
        assert.deepEqual(found.map(({ shard }) => shard), [2]);
        assert.deepEqual(missing, [1]);
    });

    it('trusts a record over the plan, and a file named like a shard is not a folder', () => {
        const dir = temp();
        write(path.join(dir, 'shard-record.json'), { shard: 2 });
        const { found, missing } = collectShards(dir, 'shard-', [1], 'shard-record.json');
        assert.deepEqual(found.map(({ shard }) => shard), [2]);
        assert.deepEqual(missing, [1]);
    });

    it('finds nothing in an empty or absent folder', () => {
        assert.deepEqual(collectShards(path.join(temp(), 'none'), 'shard-', [1]).missing, [1]);
    });
});

describe('mergeReports', () => {
    const testFiles = (name) => ({ [name]: { tests: [{ id: '0', name: `${name} test`, location: at(1).start }] } });

    it('unions disjoint shards and rebuilds test ids', () => {
        const scopes = new Map([[1, parseScope('a.ts')], [2, parseScope('b.ts')]]);
        const { report: merged, files, mutants, stale } = mergeReports([
            {
                shard: 1,
                report: report({ 'a.ts': [mutant(1, 'Killed', { killedBy: ['0'] })] }, testFiles('a.test.ts')),
            },
            {
                shard: 2,
                report: report({ 'b.ts': [mutant(1, 'Survived', { coveredBy: ['0'] })] }, testFiles('b.test.ts')),
            },
        ], scopes);
        assert.deepEqual([files, mutants, stale], [2, 2, 0]);
        assert.deepEqual(merged.files['a.ts'].mutants[0].killedBy, ['0']);
        assert.deepEqual(merged.files['b.ts'].mutants[0].coveredBy, ['1']);
        assert.equal(merged.thresholds.break, 50);
    });

    it('prefers the owner and drops a carried copy its owner no longer reports', () => {
        const scopes = new Map([[1, parseScope('a.ts')], [2, parseScope('b.ts')]]);
        const { report: merged, stale } = mergeReports([
            { shard: 1, report: report({ 'a.ts': [mutant(1, 'Killed')], 'b.ts': [mutant(9, 'Killed')] }) },
            { shard: 2, report: report({ 'b.ts': [mutant(2, 'Survived')] }) },
        ], scopes);
        assert.equal(stale, 1);
        assert.deepEqual(merged.files['b.ts'].mutants.map(({ status }) => status), ['Survived']);
    });

    it('treats spellings of one path as one file', () => {
        const scopes = new Map([[1, parseScope('a.ts')]]);
        const { files, mutants } = mergeReports([
            { shard: null, report: report({ 'a.ts': [mutant(1, 'Killed'), mutant(2, 'Survived')] }) },
            { shard: 1, report: report({ './a.ts': [mutant(1, 'Killed'), mutant(2, 'Survived')] }) },
        ], scopes);
        assert.deepEqual([files, mutants], [1, 2]);
    });
});

describe('scoreReport', () => {
    it("uses the metrics package from Stryker's own install", async () => {
        const dir = temp();
        write(path.join(dir, 'package.json'), {});
        const core = path.join(dir, 'node_modules', '@stryker-mutator', 'core');
        write(path.join(core, 'package.json'), { name: '@stryker-mutator/core', type: 'module' });
        const metrics = path.join(core, 'node_modules', 'mutation-testing-metrics');
        write(path.join(metrics, 'package.json'),
            { name: 'mutation-testing-metrics', type: 'module', main: 'index.js' });
        write(path.join(metrics, 'index.js'), `export const calculateMutationTestMetrics = (report) => {
            const all = Object.values(report.files).flatMap((file) => file.mutants);
            const count = (...statuses) => all.filter((m) => statuses.includes(m.status)).length;
            const detected = count('Killed', 'Timeout');
            const undetected = count('Survived', 'NoCoverage');
            return { systemUnderTestMetrics: { metrics: {
                mutationScore: (detected / (detected + undetected)) * 100, totalDetected: detected,
                timeout: count('Timeout'), totalUndetected: undetected, totalValid: detected + undetected,
            } } };
        };`);
        const result = await scoreReport(report({
            'a.ts': [mutant(1, 'Killed'), mutant(2, 'Timeout'), mutant(3, 'Survived'), mutant(4, 'Ignored')],
        }), dir);
        assert.deepEqual(result, { score: (2 / 3) * 100, detected: 2, timedOut: 1, undetected: 1, counted: 3 });
    });
});

describe('breaks', () => {
    it('breaks only under a numeric threshold, as Stryker does', () => {
        assert.ok(breaks(89.99, 90));
        assert.ok(!breaks(90, 90));
        assert.ok(!breaks(Number.NaN, 90));
        assert.ok(!breaks(10, null));
    });
});

describe('expandMutate', () => {
    it('selects files on disk in order, skipping dependencies', () => {
        const dir = temp();
        for (const file of ['lib/a.ts', 'lib/a.test.ts', 'lib/deep/b.ts', 'node_modules/x/lib/c.ts', 'scripts/d.ts']) {
            write(path.join(dir, file), 'x');
        }
        assert.deepEqual(expandMutate(['lib/**/*.ts', '!**/*.test.ts', 'scripts/d.ts:1-2', '', 'none/*.ts'], dir),
            ['lib/a.ts', 'lib/deep/b.ts', 'scripts/d.ts']);
        assert.deepEqual(expandMutate(['**/c.ts'], dir), []);
        assert.deepEqual(expandMutate(['lib/a.ts', '!./lib/a.ts'], dir), []);
    });
});

describe('packFiles', () => {
    it('places the heaviest files first on the least loaded shard', () => {
        const bins = packFiles(new Map([['a', 5], ['b', 4], ['c', 3], ['d', 3], ['e', 1]]), 2);
        assert.deepEqual(bins.map(({ weight, files }) => [weight, files]), [[8, ['a', 'd']], [8, ['b', 'c', 'e']]]);
        assert.equal(packFiles(new Map([['a', 1]]), 4).length, 1);
        assert.deepEqual(packFiles(new Map([['a', 0], ['b', 0], ['c', 0]]), 3).map(({ files }) => files),
            [['a'], ['b'], ['c']]);
    });
});

describe('testCosts and mutantWeight', () => {
    it('weighs a mutant by how much of the code its tests cover', () => {
        const merged = report({
            'a.ts': [mutant(1, 'Killed', { coveredBy: ['wide'], testsCompleted: 1 })],
            'b.ts': [1, 2, 3, 4].map((line) => mutant(line, 'Killed', { coveredBy: ['wide', 'narrow'] })),
        });
        const costs = testCosts(merged);
        assert.deepEqual([costs.get('wide'), costs.get('narrow')], [5 / 4.5, 4 / 4.5]);
        assert.equal(mutantWeight(merged.files['a.ts'].mutants[0], costs), 1 + 5 / 4.5);
        assert.equal(mutantWeight(merged.files['b.ts'].mutants[0], costs), 3);
    });

    it('counts each test of a static mutant as the average, and falls back to the test count', () => {
        const costs = new Map([['wide', 4]]);
        assert.equal(mutantWeight(mutant(1, 'Killed', { static: true, coveredBy: ['wide'], testsCompleted: 9 }),
            costs), 10);
        assert.equal(mutantWeight(mutant(1, 'Survived', { testsCompleted: 3 })), 4);
        assert.equal(mutantWeight(mutant(1, 'NoCoverage')), 1);
    });
});

describe('measureSweep', () => {
    it("shares each shard's seconds out by the weight of its files' mutants", () => {
        const merged = report({
            'a.ts': [mutant(1, 'Killed', { testsCompleted: 2 })],
            'b.ts': [mutant(1, 'Killed', { testsCompleted: 0 })],
            'c.ts': [mutant(1, 'Killed')],
        });
        const { files } = measureSweep(merged, [
            { scope: parseScope('a.ts,b.ts'), seconds: 400 },
            { scope: parseScope('c.ts,types.ts'), seconds: 60 },
            { scope: parseScope('d.ts'), seconds: 0 },
        ]);
        assert.deepEqual(files, { 'a.ts': 300, 'b.ts': 100, 'c.ts': 60, 'types.ts': 0, 'd.ts': 0 });
    });

    it('weighs only the mutants inside each shard, and adds up shards that share a file', () => {
        const merged = report({
            'a.ts': [mutant(1, 'Killed', { testsCompleted: 0 }), mutant(20, 'Killed', { testsCompleted: 98 })],
            'b.ts': [mutant(1, 'Killed', { testsCompleted: 0 })],
        });
        const { files, lines } = measureSweep(merged, [
            { scope: parseScope('a.ts:1-1,b.ts'), seconds: 20 },
            { scope: parseScope('a.ts:2-30'), seconds: 30 },
        ]);
        assert.deepEqual(files, { 'a.ts': 40, 'b.ts': 10 });
        assert.deepEqual(lines, { 'a.ts': [[1, 1, 10], [20, 1, 30]], 'b.ts': [[1, 1, 10]] });
    });

    it('gives a file covered by a wide test more of the shard than one covered by many narrow tests', () => {
        const narrow = Array.from({ length: 8 }, (_, index) => `n${index}`);
        const merged = report({
            'app.ts': [1, 2].map((line) => mutant(line, 'Killed', { coveredBy: ['app'], testsCompleted: 1 })),
            'unit.ts': [1, 2].map((line) => mutant(line, 'Killed', { coveredBy: narrow, testsCompleted: 8 })),
            'rest.ts': Array.from({ length: 40 }, (_, index) => mutant(index + 1, 'Killed', { coveredBy: ['app'] })),
        });
        const { files } = measureSweep(merged, [{ scope: parseScope('app.ts,unit.ts'), seconds: 100 }]);
        assert.ok(files['app.ts'] > 2 * files['unit.ts']);
    });

    it('records nothing for a shard whose time is not a finite number', () => {
        const merged = report({ 'a.ts': [mutant(1, 'Killed')] });
        for (const seconds of [Infinity, Number.NaN, -5]) {
            assert.deepEqual(measureSweep(merged, [{ scope: parseScope('a.ts'), seconds }]).files, { 'a.ts': 0 });
        }
    });
});

describe('estimateScope', () => {
    const counts = { 'a.ts': 100, 'b.ts': 100, 'new.ts': 50 };
    const lineCount = (file) => counts[file] ?? null;
    const entry = (file, start, end) => (start
        ? { path: file, range: true, start, end, text: `${file}:${start}-${end}` }
        : { path: file, range: false, start: 0, end: 0, text: file });
    const history = {
        version: 2,
        files: { 'a.ts': 600, 'b.ts': 20, 'gone.ts': 999 },
        lines: { 'a.ts': [[10, 3, 500], [80, 1, 100]], 'b.ts': [[10, 2, 20]] },
    };

    it('costs a measured file at what it took, and a range at what its lines took', () => {
        assert.deepEqual(estimateScope([entry('a.ts'), entry('b.ts'), entry('a.ts', 5, 15)], history, lineCount),
            [600, 20, 500]);
    });

    it("costs new lines at the file's average, and a file the sweep never saw at the sweep's", () => {
        const [added, unseen] = estimateScope([entry('a.ts', 40, 59), entry('new.ts')], history, lineCount);
        assert.equal(added, 20 * 6);
        assert.equal(unseen, 50 * (620 / 200));
    });

    it('reads a history without lines by the file average', () => {
        const [range] = estimateScope([entry('a.ts', 5, 15)], { version: 1, files: history.files }, lineCount);
        assert.equal(range, 11 * 6);
    });

    it('returns null without a usable history, and skips malformed lines', () => {
        for (const missing of [null, {}, { files: [] }, { files: { 'gone.ts': 5 } }, { files: { 'a.ts': 'x' } }]) {
            assert.equal(estimateScope([entry('a.ts')], missing, lineCount), null);
        }
        assert.equal(estimateScope([entry('new.ts')], { files: { 'a.ts': 1e308, 'b.ts': 1e308 } }, lineCount), null);
        assert.equal(estimateScope([entry('a.ts'), entry('b.ts')], { files: { 'a.ts': 1e308, 'b.ts': 1e308 } },
            lineCount), null);
        const odd = { files: { 'a.ts': 600 }, lines: { 'a.ts': [null, [10, 1, 'x'], [12, 1, 30]] } };
        assert.deepEqual(estimateScope([entry('a.ts', 1, 20)], odd, lineCount), [120]);
    });
});

describe('planScope', () => {
    const entry = (file, lines, range) => (range
        ? { path: file, range: true, start: range[0], end: range[1], text: `${file}:${range[0]}-${range[1]}` }
        : { path: file, range: false, start: 0, end: 0, text: file, lines });
    const paths = (bins) => bins.map((bin) => bin.entries.map(({ text }) => text));

    it('balances files of like size but unlike cost by cost', () => {
        const entries = [entry('a.ts'), entry('b.ts'), entry('c.ts'), entry('d.ts')];
        assert.deepEqual(paths(planScope(entries, [100, 100, 90, 90], 2)), [['a.ts', 'c.ts'], ['b.ts', 'd.ts']]);
        const bins = planScope(entries, [6000, 300, 5800, 290], 2);
        assert.deepEqual(paths(bins), [['a.ts', 'd.ts'], ['b.ts', 'c.ts']]);
        assert.deepEqual(bins.map(({ weight }) => weight), [6290, 6100]);
    });

    it('splits a file heavier than its share across shards by range, and never cuts a range', () => {
        const entries = [entry('big.ts', 0, [1, 10]), entry('big.ts', 0, [50, 60]), entry('small.ts')];
        assert.deepEqual(paths(planScope(entries, [100, 90, 10], 2)), [['big.ts:1-10'], ['big.ts:50-60', 'small.ts']]);
        assert.deepEqual(paths(planScope(entries, [1, 1, 100], 2)), [['small.ts'], ['big.ts:1-10', 'big.ts:50-60']]);
    });

    it('keeps overlapping ranges of a file on one shard, so no mutant runs twice', () => {
        const entries = [entry('a.ts', 0, [1, 10]), entry('a.ts', 0, [5, 15])];
        assert.deepEqual(paths(planScope(entries, [10, 11], 2)), [['a.ts:1-10', 'a.ts:5-15']]);
        const touching = [entry('a.ts', 0, [1, 10]), entry('a.ts', 0, [10, 15])];
        assert.deepEqual(paths(planScope(touching, [10, 11], 2)), [['a.ts:1-10', 'a.ts:10-15']]);
    });

    it('keeps zero-cost units spread and never plans more shards than units', () => {
        const entries = [entry('a.ts'), entry('b.ts'), entry('c.ts')];
        assert.deepEqual(paths(planScope(entries, [0, 0, 0], 6)), [['a.ts'], ['b.ts'], ['c.ts']]);
    });
});
