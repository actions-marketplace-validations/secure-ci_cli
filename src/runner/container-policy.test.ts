import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  invalidImageReason,
  splitReservedOptions,
  unsafeServiceOptions,
  unsafeServiceVolumeReason
} from './container-policy';

describe('container-policy', () => {
  describe('invalidImageReason', () => {
    for (const image of [
      'alpine',
      'node:20',
      'ghcr.io/owner/img:1.2.3',
      'localhost:5000/x/y@sha256:' + 'a'.repeat(64),
      'secureci-action-0123456789ab'
    ]) {
      it(`accepts ${image}`, () => {
        expect(invalidImageReason(image)).toBeUndefined();
      });
    }

    for (const image of [
      '',
      '--privileged',
      '-v=/:/host',
      'alpine --privileged',
      'alpine\n',
      ' alpine'
    ]) {
      it(`rejects ${JSON.stringify(image)}`, () => {
        expect(invalidImageReason(image)).toMatch(/[Ii]nvalid image/);
      });
    }
  });

  describe('unsafeServiceOptions', () => {
    it('allows the usual health-check and resource options', () => {
      expect(
        unsafeServiceOptions([
          '--health-cmd',
          'pg_isready',
          '--health-interval=10s',
          '-e',
          'A=B',
          '--shm-size',
          '1g',
          '--tmpfs',
          '/run',
          '--user',
          '0'
        ])
      ).toEqual([]);
    });

    it('flags privilege, namespace, device and mount options in any form', () => {
      expect(
        unsafeServiceOptions([
          '--privileged',
          '--cap-add=SYS_ADMIN',
          '--cap-add',
          'ALL',
          '--security-opt',
          'seccomp=unconfined',
          '--pid=host',
          '--network',
          'host',
          '--net=host',
          '--ipc',
          'host',
          '--userns=host',
          '--uts=host',
          '--cgroupns=host',
          '--device',
          '/dev/sda',
          '-v',
          '/:/host',
          '--volume=/:/host',
          '--mount',
          'type=bind,src=/,dst=/host',
          '--volumes-from',
          'other',
          '--runtime=runc',
          '--cgroup-parent',
          '/'
        ])
      ).toEqual([
        '--privileged',
        '--cap-add',
        '--cap-add',
        '--security-opt',
        '--pid',
        '--network',
        '--net',
        '--ipc',
        '--userns',
        '--uts',
        '--cgroupns',
        '--device',
        '-v',
        '--volume',
        '--mount',
        '--volumes-from',
        '--runtime',
        '--cgroup-parent'
      ]);
    });

    it('flags short -v with an attached value', () => {
      expect(unsafeServiceOptions(['-v/:/host'])).toEqual(['-v']);
    });

    it('does not flag the values of safe options', () => {
      expect(unsafeServiceOptions(['--health-cmd', '--privileged'])).toEqual(
        []
      );
    });
  });

  describe('splitReservedOptions', () => {
    const reserved = new Set([
      '--entrypoint',
      '--workdir',
      '-w',
      '--memory',
      '-m'
    ]);

    it('drops reserved options with their values, in any form', () => {
      expect(
        splitReservedOptions(
          [
            '--entrypoint',
            'sh',
            '-w',
            '/tmp',
            '--workdir=/x',
            '-m64g',
            '--cpus',
            '2'
          ],
          reserved
        )
      ).toEqual({
        kept: ['--cpus', '2'],
        dropped: ['--entrypoint', '-w', '--workdir', '-m']
      });
    });

    it('keeps the values of other options, even when they look reserved', () => {
      expect(
        splitReservedOptions(
          ['--health-cmd', '--entrypoint', '--user', '1001'],
          reserved
        )
      ).toEqual({
        kept: ['--health-cmd', '--entrypoint', '--user', '1001'],
        dropped: []
      });
    });
  });

  describe('unsafeServiceVolumeReason', () => {
    let workspace: string;
    beforeEach(() => {
      workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-policy-'))
      );
      fs.mkdirSync(path.join(workspace, '.git'));
      fs.mkdirSync(path.join(workspace, 'data'));
    });
    afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

    for (const spec of [
      'pgdata:/var/lib/postgresql/data',
      '/var/lib/data',
      'my_volume:/data:ro'
    ]) {
      it(`allows named or anonymous volume ${spec}`, () => {
        expect(unsafeServiceVolumeReason(spec, workspace)).toBeUndefined();
      });
    }

    it('allows a bind mount inside the workspace', () => {
      expect(
        unsafeServiceVolumeReason(`${workspace}/data:/data`, workspace)
      ).toBeUndefined();
    });

    for (const spec of [
      '/:/host',
      '/var/run/docker.sock:/var/run/docker.sock',
      '~/.ssh:/ssh',
      '../outside:/x',
      './data:/data'
    ]) {
      it(`rejects host bind mount ${spec}`, () => {
        expect(unsafeServiceVolumeReason(spec, workspace)).toMatch(
          /outside the workspace|relative/
        );
      });
    }

    it('rejects the workspace .git, or the workspace root that holds it', () => {
      expect(
        unsafeServiceVolumeReason(`${workspace}/.git:/g`, workspace)
      ).toMatch(/\.git/);
      expect(unsafeServiceVolumeReason(`${workspace}:/w`, workspace)).toMatch(
        /\.git/
      );
    });

    it('rejects a workspace path that is a symlink out of it', () => {
      fs.symlinkSync('/', path.join(workspace, 'root'));
      expect(
        unsafeServiceVolumeReason(`${workspace}/root:/host`, workspace)
      ).toMatch(/outside the workspace/);
    });
  });
});
