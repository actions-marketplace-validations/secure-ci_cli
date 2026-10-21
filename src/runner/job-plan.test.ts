import { describe, it, expect } from 'vitest';
import { createContext } from './expression';
import {
  expandMatrix,
  filterMatrix,
  matrixValueText,
  noMatrixMatchMessage,
  parseMatrixFilter,
  unknownMatrixKeys
} from './job-plan';

describe('job-plan: --matrix filter (#50)', () => {
  const ctx = createContext();

  describe('parseMatrixFilter', () => {
    it('returns an empty filter when no --matrix is given', () => {
      expect(parseMatrixFilter(undefined)).toEqual({});
      expect(parseMatrixFilter([])).toEqual({});
    });

    it('parses repeatable key:value pairs', () => {
      expect(parseMatrixFilter(['node:20', 'os:ubuntu-latest'])).toEqual({
        node: ['20'],
        os: ['ubuntu-latest']
      });
      expect(parseMatrixFilter('node:20')).toEqual({ node: ['20'] });
    });

    it('splits on the first colon only, so values may contain colons', () => {
      expect(parseMatrixFilter(['image:node:20-alpine'])).toEqual({
        image: ['node:20-alpine']
      });
      expect(parseMatrixFilter(['cfg:{"a":1}'])).toEqual({
        cfg: ['{"a":1}']
      });
    });

    it('collects repeated keys as alternatives', () => {
      expect(parseMatrixFilter(['node:18', 'node:20', 'node:18'])).toEqual({
        node: ['18', '20']
      });
    });

    it('allows an empty value', () => {
      expect(parseMatrixFilter(['tag:'])).toEqual({ tag: [''] });
    });

    it('rejects a pair without a colon or with an empty key', () => {
      expect(() => parseMatrixFilter(['node=20'])).toThrow(
        'Invalid --matrix argument "node=20": expected key:value'
      );
      expect(() => parseMatrixFilter([':20'])).toThrow(
        'Invalid --matrix argument ":20": expected key:value'
      );
    });
  });

  describe('matrixValueText', () => {
    it('renders values as GitHub does in job names', () => {
      expect(matrixValueText('ubuntu-latest')).toBe('ubuntu-latest');
      expect(matrixValueText(20)).toBe('20');
      expect(matrixValueText(3.1)).toBe('3.1');
      expect(matrixValueText(true)).toBe('true');
      expect(matrixValueText(null)).toBe('null');
      expect(matrixValueText({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
      expect(matrixValueText(['x', 1])).toBe('["x",1]');
    });
  });

  describe('filterMatrix', () => {
    const matrix = {
      node: [18, 20, 22],
      os: ['ubuntu-latest', 'macos-latest']
    };

    it('keeps everything, applying no keys, with an empty filter', () => {
      const combos = expandMatrix(matrix, ctx);
      const result = filterMatrix(combos, {});
      expect(result.keys).toEqual([]);
      expect(result.matches.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('compares numeric values as strings', () => {
      const result = filterMatrix(expandMatrix(matrix, ctx), {
        node: ['20']
      });
      expect(result.keys).toEqual(['node']);
      expect(result.matches).toEqual([
        { index: 2, values: { node: 20, os: 'ubuntu-latest' } },
        { index: 3, values: { node: 20, os: 'macos-latest' } }
      ]);
    });

    it('requires every given key to match', () => {
      const result = filterMatrix(expandMatrix(matrix, ctx), {
        node: ['20'],
        os: ['macos-latest']
      });
      expect(result.matches).toEqual([
        { index: 3, values: { node: 20, os: 'macos-latest' } }
      ]);
    });

    it('treats repeated values for one key as alternatives', () => {
      const result = filterMatrix(expandMatrix(matrix, ctx), {
        node: ['18', '22'],
        os: ['ubuntu-latest']
      });
      expect(result.matches.map((m) => m.values)).toEqual([
        { node: 18, os: 'ubuntu-latest' },
        { node: 22, os: 'ubuntu-latest' }
      ]);
    });

    it('matches booleans and object values by their rendered text', () => {
      const combos = expandMatrix(
        {
          experimental: [true, false],
          cfg: [{ arch: 'x64' }, { arch: 'arm64' }]
        },
        ctx
      );
      const result = filterMatrix(combos, {
        experimental: ['false'],
        cfg: ['{"arch":"arm64"}']
      });
      expect(result.matches.map((m) => m.values)).toEqual([
        { experimental: false, cfg: { arch: 'arm64' } }
      ]);
    });

    it('filters after exclude and include are applied', () => {
      const combos = expandMatrix(
        {
          os: ['linux', 'mac'],
          node: [18, 20],
          exclude: [{ os: 'mac', node: 18 }],
          include: [
            { os: 'mac', experimental: true },
            { os: 'windows', node: 20 }
          ]
        },
        ctx
      );
      // An excluded combination can't be selected.
      expect(
        filterMatrix(combos, { os: ['mac'], node: ['18'] }).matches
      ).toEqual([]);
      // Values merged in by include can be filtered on.
      expect(filterMatrix(combos, { experimental: ['true'] }).matches).toEqual([
        { index: 2, values: { os: 'mac', node: 20, experimental: true } }
      ]);
      // Combinations added by include can be selected.
      expect(filterMatrix(combos, { os: ['windows'] }).matches).toEqual([
        { index: 3, values: { os: 'windows', node: 20 } }
      ]);
    });

    it('drops combinations that lack a key the matrix defines elsewhere', () => {
      const extra = expandMatrix(
        { include: [{ node: 20 }, { os: 'linux' }] },
        ctx
      );
      // The os-only combination has no node, so it can't match node:20.
      expect(filterMatrix(extra, { node: ['20'] }).matches).toEqual([
        { index: 0, values: { node: 20 } }
      ]);
    });

    it('filters expression-generated matrices once resolved', () => {
      const combos = expandMatrix(
        '${{ fromJSON(\'{"node":[18,20],"include":[{"node":22,"os":"mac"}]}\') }}',
        ctx
      );
      expect(filterMatrix(combos, { node: ['22'] }).matches).toEqual([
        { index: 2, values: { node: 22, os: 'mac' } }
      ]);
      const fromNeeds = expandMatrix('${{ fromJSON(needs.setup.outputs.m) }}', {
        ...ctx,
        needs: {
          setup: { result: 'success', outputs: { m: '{"shard":[1,2,3]}' } }
        }
      });
      expect(
        filterMatrix(fromNeeds, { shard: ['2'] }).matches.map((m) => m.values)
      ).toEqual([{ shard: 2 }]);
    });

    it('ignores keys the matrix does not define', () => {
      const result = filterMatrix(expandMatrix(matrix, ctx), {
        python: ['3.12'],
        node: ['22']
      });
      expect(result.keys).toEqual(['node']);
      expect(result.matches.map((m) => m.index)).toEqual([4, 5]);
    });

    it('leaves a job without a matrix unaffected', () => {
      const result = filterMatrix(expandMatrix(undefined, ctx), {
        node: ['20']
      });
      expect(result.keys).toEqual([]);
      expect(result.matches).toEqual([{ index: 0, values: {} }]);
    });

    it('returns no matches when nothing fits', () => {
      const result = filterMatrix(expandMatrix(matrix, ctx), { node: ['16'] });
      expect(result.keys).toEqual(['node']);
      expect(result.matches).toEqual([]);
    });
  });

  describe('noMatrixMatchMessage', () => {
    it('lists the filter and the available combinations', () => {
      const combos = expandMatrix({ node: [18, 20], os: ['linux'] }, ctx);
      expect(noMatrixMatchMessage('test', { node: ['16', '17'] }, combos)).toBe(
        [
          'No matrix combination of job "test" matches --matrix node:16, node:17; skipping it. Available combinations:',
          '  node: 18, os: linux',
          '  node: 20, os: linux'
        ].join('\n')
      );
    });
  });

  describe('unknownMatrixKeys', () => {
    it('returns the filter keys no matrix defined', () => {
      expect(
        unknownMatrixKeys(
          { node: ['20'], pyhton: ['3'], os: ['x'] },
          new Set(['node', 'os'])
        )
      ).toEqual(['pyhton']);
      expect(unknownMatrixKeys({}, new Set())).toEqual([]);
    });
  });
});
