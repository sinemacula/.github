import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
    breaks,
    collectShards,
    escape,
    expandMutate,
    inScope,
    measureFiles,
    mergeReports,
    packFiles,
    parseScope,
    readFresh,
    reportProblems,
    scoreReport,
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
    });
});

describe('packFiles', () => {
    it('places the heaviest files first on the least loaded shard', () => {
        const bins = packFiles(new Map([['a', 5], ['b', 4], ['c', 3], ['d', 3], ['e', 1]]), 2);
        assert.deepEqual(bins.map(({ weight, files }) => [weight, files]), [[8, ['a', 'd']], [8, ['b', 'c', 'e']]]);
        assert.equal(packFiles(new Map([['a', 1]]), 4).length, 1);
    });
});

describe('measureFiles', () => {
    it("shares each shard's seconds out by the weight of its files' mutants", () => {
        const merged = report({
            'a.ts': [mutant(1, 'Killed', { testsCompleted: 2 })],
            'b.ts': [mutant(1, 'Killed', { testsCompleted: 0 })],
            'c.ts': [mutant(1, 'Killed')],
        });
        const files = measureFiles(merged, [
            { scope: parseScope('a.ts,b.ts'), seconds: 400 },
            { scope: parseScope('c.ts,types.ts'), seconds: 60 },
            { scope: parseScope('d.ts'), seconds: 0 },
        ]);
        assert.deepEqual(files, { 'a.ts': 300, 'b.ts': 100, 'c.ts': 60, 'types.ts': 0 });
    });
});
