# Docker Container Isolation - Implementation Plan

## Executive Summary

This document outlines the implementation plan for adding Docker container isolation to actly, ensuring workflows and actions execute in isolated containers rather than directly on the host machine.

**Goal**: Execute all workflow steps and actions in Docker containers for security and isolation.

**Timeline**: 3-4 days of focused implementation

**Impact**: Enhanced security, predictable environments, better isolation

---

## 1. Current State Analysis

### Current Execution Flow

```
User → CLI → executeWorkflow() → executeStep() → child_process.exec() → Host Shell
                                                                        ↓
                                                            Runs on HOST with full access
```

### Problems with Current Approach

1. **Security Risk**: Commands run with actly's privileges
2. **Filesystem Access**: Full access to host filesystem
3. **System State**: Can modify host system
4. **No Isolation**: Multiple steps share environment
5. **Unpredictable**: Depends on host OS and installed packages

---

## 2. Target Architecture

### New Execution Flow

```
User → CLI → executeWorkflow() → executeStep() → DockerExecutor → Docker Container → Isolated Shell
                                                 ↓ (if Docker unavailable)
                                                 → child_process.exec() → Host Shell (with warning)
```

### Benefits

- ✅ Process isolation (separate PID namespace)
- ✅ Filesystem isolation (no host access)
- ✅ Network isolation (disabled by default)
- ✅ Clean environment per step
- ✅ Predictable Ubuntu/Node.js environment
- ✅ Resource limits (memory, CPU)
- ✅ Automatic cleanup

---

## 3. Implementation Phases

### Phase 1: Foundation (Day 1, 4-6 hours)

#### 1.1 Add Dependencies

**File**: `package.json`

```json
{
  "dependencies": {
    "dockerode": "^4.0.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.0"
  }
}
```

**Commands**:

```bash
npm install dockerode
npm install --save-dev @types/dockerode
```

#### 1.2 Create DockerExecutor Class

**File**: `src/runner/docker-executor.ts`

**Responsibilities**:

- Check Docker availability
- Pull required images
- Create and start containers
- Execute commands in containers
- Collect output (stdout/stderr)
- Handle timeouts
- Clean up containers
- Error handling

**Key Methods**:

- `isAvailable()`: Check if Docker daemon is running
- `execute(options)`: Execute command in container
- `pullImage(image)`: Ensure image is available
- `createContainer(config)`: Create Docker container
- `cleanup(container)`: Remove container

**Images to Support**:

- `ubuntu:22.04` - For shell commands
- `node:20` - For JavaScript actions
- `node:22` - For newer JavaScript actions
- Custom images via configuration

#### 1.3 Update Type Definitions

**File**: `src/types/index.ts`

Add to `RunOptions`:

```typescript
export interface RunOptions {
  // ... existing options
  useDocker?: boolean; // Default: true
  dockerImage?: string; // Custom image
  dockerTimeout?: number; // Container timeout (ms)
  disableNetwork?: boolean; // Default: true
  dockerMemoryLimit?: string; // e.g., "512m"
}
```

---

### Phase 2: Core Implementation (Day 2, 6-8 hours)

#### 2.1 Implement DockerExecutor

**Core Logic**:

```typescript
export class DockerExecutor {
  private docker: Docker;
  private availableCache: boolean | null = null;

  constructor() {
    this.docker = new Docker();
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== null) {
      return this.availableCache;
    }

    try {
      await this.docker.ping();
      this.availableCache = true;
      logger.debug('Docker daemon is available');
      return true;
    } catch (error) {
      this.availableCache = false;
      logger.debug('Docker daemon is not available');
      return false;
    }
  }

  async execute(
    options: DockerExecutionOptions
  ): Promise<DockerExecutionResult> {
    const startTime = Date.now();
    const image = options.image || 'ubuntu:22.04';

    // Ensure image is available
    await this.ensureImage(image);

    // Create container
    const container = await this.createContainer({
      image,
      command: options.command,
      env: options.env,
      workingDir: options.workingDir,
      memoryLimit: options.memoryLimit,
      networkMode: options.disableNetwork ? 'none' : 'bridge'
    });

    try {
      // Start container
      await container.start();

      // Attach to output streams
      const stream = await container.logs({
        stdout: true,
        stderr: true,
        follow: true
      });

      // Collect output
      let output = '';
      stream.on('data', (chunk) => {
        output += this.cleanDockerOutput(chunk);
      });

      // Wait for stream to complete
      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
      });

      // Wait for container with timeout
      const result = await this.waitWithTimeout(
        container,
        options.timeout || 300000
      );

      return {
        success: result.StatusCode === 0,
        output: output.trim(),
        exitCode: result.StatusCode,
        duration: Date.now() - startTime
      };
    } finally {
      // Always clean up container
      await this.cleanup(container);
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      logger.debug(`Image ${image} already available`);
    } catch {
      logger.info(`Pulling Docker image: ${image}...`);
      await this.pullImage(image);
      logger.success(`Image ${image} pulled successfully`);
    }
  }

  private async pullImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: any, stream: any) => {
        if (err) return reject(err);

        this.docker.modem.followProgress(
          stream,
          (err: any) => {
            if (err) return reject(err);
            resolve();
          },
          (event: any) => {
            // Progress logging
            if (event.status) {
              logger.debug(`${event.status} ${event.progress || ''}`);
            }
          }
        );
      });
    });
  }

  private async cleanup(container: any): Promise<void> {
    try {
      await container.remove({ force: true });
      logger.debug('Container cleaned up successfully');
    } catch (error) {
      logger.warn(`Failed to cleanup container: ${error}`);
    }
  }

  private cleanDockerOutput(buffer: Buffer): string {
    // Docker output includes 8-byte headers, strip them
    const str = buffer.toString();
    return str.replace(/[\x00-\x08]/g, '');
  }
}
```

#### 2.2 Integrate with Executor

**File**: `src/runner/executor.ts`

**Changes**:

1. Import DockerExecutor
2. Create singleton instance
3. Check Docker availability on first use
4. Route execution through Docker when available
5. Fallback to host execution with warning

**Implementation**:

```typescript
import { DockerExecutor } from './docker-executor';

// Module-level singleton
let dockerExecutor: DockerExecutor | null = null;
let dockerAvailable: boolean | null = null;

async function getDockerExecutor(options: RunOptions): Promise<DockerExecutor | null> {
  // Skip Docker if explicitly disabled
  if (options.useDocker === false) {
    return null;
  }

  // Initialize and check availability once
  if (dockerAvailable === null) {
    dockerExecutor = new DockerExecutor();
    dockerAvailable = await dockerExecutor.isAvailable();

    if (!dockerAvailable) {
      logger.warn('Docker is not available. Workflows will run on host.');
      logger.warn('For better isolation, install Docker: https://docs.docker.com/get-docker/');
    } else {
      logger.info('Docker is available. Using container isolation.');
    }
  }

  return dockerAvailable ? dockerExecutor : null;
}

async function executeStep(step: Step, options: RunOptions): Promise<StepResult> {
  const startTime = Date.now();

  try {
    if (step.run) {
      // ... existing variable replacement code ...

      // Try Docker execution first
      const docker = await getDockerExecutor(options);

      if (docker) {
        logger.debug('Executing in Docker container');

        const result = await docker.execute({
          command,
          image: options.dockerImage || 'ubuntu:22.04',
          workingDir: step['working-directory'] || '/workspace',
          env: {
            ...options.inputs,
            ...options.secrets,
          },
          timeout: options.dockerTimeout || 300000,
          disableNetwork: options.disableNetwork !== false,
          memoryLimit: options.dockerMemoryLimit || '512m',
        });

        if (result.output) {
          logger.info(result.output);
        }

        if (result.success) {
          logger.success(`Step completed: ${step.name || 'unnamed'}`);
        } else {
          logger.error(`Step failed with exit code ${result.exitCode}`);
        }

        return {
          step,
          success: result.success,
          output: result.output,
          duration: result.duration,
        };
      }

      // Fallback to host execution
      logger.debug('Executing on host (Docker not available)');
      // ... existing execAsync code ...
    }

    // Handle 'uses' actions
    if (step.uses) {
      return await executeAction(step, options, startTime);
    }

    // ... rest of function ...
  }
}
```

---

### Phase 3: Testing (Day 3, 4-6 hours)

#### 3.1 Unit Tests

**File**: `src/runner/docker-executor.test.ts`

**Test Cases**:

```typescript
describe('DockerExecutor', () => {
  describe('isAvailable', () => {
    it('should return true when Docker is available', async () => {
      const executor = new DockerExecutor();
      const available = await executor.isAvailable();
      // Skip test if Docker not installed
      if (!available) {
        console.log('Skipping: Docker not available');
        return;
      }
      expect(available).toBe(true);
    });

    it('should cache availability check', async () => {
      const executor = new DockerExecutor();
      const first = await executor.isAvailable();
      const second = await executor.isAvailable();
      expect(first).toBe(second);
    });
  });

  describe('execute', () => {
    it('should execute simple echo command', async () => {
      const executor = new DockerExecutor();
      if (!(await executor.isAvailable())) {
        return; // Skip if Docker not available
      }

      const result = await executor.execute({
        command: 'echo "Hello from Docker"'
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello from Docker');
      expect(result.exitCode).toBe(0);
    });

    it('should handle command failures', async () => {
      const executor = new DockerExecutor();
      if (!(await executor.isAvailable())) return;

      const result = await executor.execute({
        command: 'exit 1'
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should timeout long-running commands', async () => {
      const executor = new DockerExecutor();
      if (!(await executor.isAvailable())) return;

      const result = await executor.execute({
        command: 'sleep 10',
        timeout: 1000 // 1 second
      });

      expect(result.success).toBe(false);
      expect(result.duration).toBeLessThan(2000);
    });

    it('should pass environment variables', async () => {
      const executor = new DockerExecutor();
      if (!(await executor.isAvailable())) return;

      const result = await executor.execute({
        command: 'echo $TEST_VAR',
        env: { TEST_VAR: 'test-value' }
      });

      expect(result.output).toContain('test-value');
    });

    it('should use custom Docker image', async () => {
      const executor = new DockerExecutor();
      if (!(await executor.isAvailable())) return;

      const result = await executor.execute({
        command: 'node --version',
        image: 'node:20'
      });

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/v20\./);
    });
  });
});
```

#### 3.2 Integration Tests

**File**: `src/runner/executor.test.ts` (add to existing tests)

**Test Cases**:

```typescript
describe('Docker Integration', () => {
  it('should execute workflow step in Docker container', async () => {
    const executor = new DockerExecutor();
    if (!(await executor.isAvailable())) {
      console.log('Skipping: Docker not available');
      return;
    }

    const workflow = `
name: Docker Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Echo in Docker
        run: echo "Running in Docker"
    `;

    const workflowPath = '/tmp/docker-test-workflow.yml';
    fs.writeFileSync(workflowPath, workflow);

    const result = await executeWorkflow(workflowPath, {
      useDocker: true
    });

    expect(result.success).toBe(true);
    expect(result.jobs[0].steps[0].output).toContain('Running in Docker');

    fs.unlinkSync(workflowPath);
  });

  it('should fallback to host when Docker disabled', async () => {
    const workflow = `
name: Host Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Echo on host
        run: echo "Running on host"
    `;

    const workflowPath = '/tmp/host-test-workflow.yml';
    fs.writeFileSync(workflowPath, workflow);

    const result = await executeWorkflow(workflowPath, {
      useDocker: false
    });

    expect(result.success).toBe(true);

    fs.unlinkSync(workflowPath);
  });
});
```

---

### Phase 4: CLI & Documentation (Day 3-4, 2-3 hours)

#### 4.1 Update CLI

**File**: `src/cli.ts`

**Add Options**:

```typescript
program
  .option('--no-docker', 'Disable Docker container isolation')
  .option(
    '--docker-image <image>',
    'Custom Docker image (default: ubuntu:22.04)'
  )
  .option('--docker-timeout <ms>', 'Container timeout in milliseconds')
  .option('--docker-memory <limit>', 'Memory limit (e.g., 512m, 1g)');

// Pass to executeWorkflow
const runOptions: RunOptions = {
  useDocker: options.docker !== false,
  dockerImage: options.dockerImage,
  dockerTimeout: options.dockerTimeout
    ? parseInt(options.dockerTimeout)
    : undefined,
  dockerMemoryLimit: options.dockerMemory
  // ... existing options
};
```

#### 4.2 Update README

**File**: `README.md`

**Add Section**:

````markdown
## Docker Container Isolation

By default, actly executes workflows in isolated Docker containers for security:

- Each step runs in a fresh container
- No access to host filesystem
- Network disabled by default
- Automatic cleanup after execution

### Requirements

- Docker Desktop (macOS/Windows) or Docker Engine (Linux)
- Docker daemon running
- User must have Docker permissions

### Installation

**macOS**:

```bash
brew install docker
```
````

**Ubuntu/Debian**:

```bash
sudo apt-get install docker.io
sudo usermod -aG docker $USER
```

**Windows**:
Download Docker Desktop from https://docker.com

### Usage

```bash
# Use default Docker isolation
actly workflow.yml

# Disable Docker isolation
actly workflow.yml --no-docker

# Use custom image
actly workflow.yml --docker-image=node:20

# Set memory limit
actly workflow.yml --docker-memory=1g

# Set timeout
actly workflow.yml --docker-timeout=600000
```

### Troubleshooting

**Docker not available**:

- Ensure Docker daemon is running: `docker ps`
- Check permissions: `docker run hello-world`
- actly will fallback to host execution with a warning

**Performance**:

- First run may be slow (pulling images)
- Subsequent runs use cached images
- Consider pre-pulling: `docker pull ubuntu:22.04`

```

---

## 4. Security Considerations

### What Docker Isolation Provides
✅ Process isolation (separate PID namespace)
✅ Filesystem isolation (read-only by default)
✅ Network isolation (disabled by default)
✅ Resource limits (CPU, memory)
✅ Clean environment per execution

### What It Doesn't Protect Against
❌ Malicious Docker images (use official images only)
❌ Docker daemon compromise
❌ Kernel-level vulnerabilities (containers share kernel)

### Best Practices
1. Use official Docker images only
2. Disable network unless required
3. Set resource limits
4. Keep Docker updated
5. Run Docker as non-root user

---

## 5. Rollout Plan

### Phase 1: Soft Launch (Week 1)
- Docker isolation optional (`--use-docker` flag)
- Default: host execution
- Gather feedback

### Phase 2: Default Enablement (Week 2)
- Docker isolation enabled by default
- Host execution as fallback
- Warning when Docker unavailable

### Phase 3: Hardening (Week 3)
- Add more security options
- Support custom images
- Performance optimization

---

## 6. Success Metrics

### Performance
- Container startup < 2 seconds
- Image pull (first time) < 30 seconds
- Overhead per step < 500ms

### Reliability
- All existing tests pass
- Docker unavailable gracefully handled
- No breaking changes

### Security
- Steps isolated from host
- Network disabled by default
- Resource limits enforced

---

## 7. Risk Mitigation

### Risk: Docker Not Installed
**Mitigation**: Graceful fallback to host execution with clear warning

### Risk: Slow Image Pulls
**Mitigation**:
- Cache images after first pull
- Provide `--docker-image` for custom images
- Document pre-pulling

### Risk: Breaking Changes
**Mitigation**:
- All changes backward compatible
- Opt-out flag available
- Extensive testing

### Risk: Resource Overhead
**Mitigation**:
- Set reasonable memory limits
- Timeout long-running containers
- Automatic cleanup

---

## 8. Timeline & Milestones

### Day 1: Foundation
- [ ] Add dockerode dependency
- [ ] Create DockerExecutor class
- [ ] Implement basic container execution
- [ ] Add Docker availability check

### Day 2: Integration
- [ ] Integrate with executor.ts
- [ ] Add fallback logic
- [ ] Update type definitions
- [ ] Basic testing

### Day 3: Testing & CLI
- [ ] Complete unit tests
- [ ] Integration tests
- [ ] Add CLI flags
- [ ] Update documentation

### Day 4: Polish & Review
- [ ] Code review
- [ ] Performance testing
- [ ] Security review
- [ ] Final documentation

---

## 9. Open Questions

1. **Default Image**: Should we use `ubuntu:22.04` or `node:20` as default?
   - **Recommendation**: `ubuntu:22.04` for shell commands, `node:20` for JavaScript actions

2. **Image Pre-pull**: Should we pre-pull images on first run?
   - **Recommendation**: Yes, but make it optional with flag

3. **Network Access**: Should network be disabled by default?
   - **Recommendation**: Yes for security, with `--enable-network` flag

4. **Custom Images**: Should we support user-provided Dockerfiles?
   - **Recommendation**: Phase 2 feature

---

## 10. Next Steps

1. **Review this plan** with stakeholders
2. **Get approval** to proceed
3. **Start Day 1 implementation**
4. **Daily progress updates**
5. **Demo after Day 2**

---

## Appendix A: File Changes Summary

### New Files
- `src/runner/docker-executor.ts` - Docker execution engine
- `src/runner/docker-executor.test.ts` - Unit tests

### Modified Files
- `package.json` - Add dockerode dependency
- `src/types/index.ts` - Add Docker options to RunOptions
- `src/runner/executor.ts` - Integrate Docker execution
- `src/cli.ts` - Add Docker CLI flags
- `README.md` - Add Docker documentation

### Configuration Files
- `.dockerignore` - Exclude files from context (optional)

---

## Appendix B: Code Review Checklist

- [ ] All tests pass
- [ ] Docker isolation working
- [ ] Fallback to host working
- [ ] Error handling comprehensive
- [ ] Logging clear and helpful
- [ ] Documentation complete
- [ ] Security review passed
- [ ] Performance acceptable
- [ ] No breaking changes
- [ ] CLI flags working

---

**Document Version**: 1.0
**Last Updated**: 2026-02-07
**Author**: GitHub Copilot
**Status**: Ready for Review
```
