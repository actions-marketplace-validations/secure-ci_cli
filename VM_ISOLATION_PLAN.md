# VM Isolation Implementation Plan

## Objective

Execute GitHub Actions workflows and actions in isolated virtual machines instead of directly on the host, providing maximum security and isolation.

## Problem Statement

Currently, actly executes workflows and actions directly on the host machine using `child_process.exec`, which:

- Runs with host privileges
- Has access to host filesystem
- Can affect host system state
- Poses security risks when running untrusted actions

## Solution: VM-Based Isolation

### Approach Options

#### Option 1: Docker Containers (Recommended)

**Pros:**

- Faster than full VMs (seconds vs minutes)
- Lower resource overhead
- Better for CI/CD workflows
- Ecosystem support (GitHub Actions already uses containers)

**Cons:**

- Shares kernel with host
- Less isolation than full VMs

#### Option 2: Lightweight VMs (Firecracker/gVisor)

**Pros:**

- VM-level isolation with container-like speed
- Used by AWS Lambda, Google Cloud Run
- Strong security boundaries

**Cons:**

- More complex setup
- Limited OS support
- Newer technology

#### Option 3: Full VMs (VirtualBox/QEMU/KVM)

**Pros:**

- Maximum isolation
- Complete OS environment
- Can run any OS

**Cons:**

- Slow startup (30-60 seconds)
- High resource overhead (GB RAM per VM)
- Complex orchestration

### Recommended Solution: Docker Containers

For actly's use case (local testing), Docker provides the best balance of isolation, speed, and developer experience.

## Implementation Plan

### Phase 1: Docker-Based Isolation

#### 1. Update Dependencies

```bash
npm install dockerode @types/dockerode
```

#### 2. Create VM Executor (`src/runner/vm-executor.ts`)

```typescript
import Docker from 'dockerode';
import { logger } from '../utils/logger';

export interface VMExecutionOptions {
  image?: string; // Default: 'ubuntu:22.04' or 'node:20'
  command: string;
  workingDir?: string;
  env?: Record<string, string>;
  timeout?: number; // milliseconds
  mounts?: Array<{ source: string; target: string }>;
}

export interface VMExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
}

export class VMExecutor {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Check if Docker is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute command in isolated container
   */
  async execute(options: VMExecutionOptions): Promise<VMExecutionResult> {
    const startTime = Date.now();
    const image = options.image || 'ubuntu:22.04';

    let container;
    try {
      // Pull image if needed
      logger.debug(`Ensuring image: ${image}`);
      await this.ensureImage(image);

      // Prepare environment
      const env = Object.entries(options.env || {}).map(
        ([k, v]) => `${k}=${v}`
      );

      // Create container
      container = await this.docker.createContainer({
        Image: image,
        Cmd: ['/bin/sh', '-c', options.command],
        WorkingDir: options.workingDir || '/workspace',
        Env: env,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          AutoRemove: false,
          Binds: options.mounts?.map((m) => `${m.source}:${m.target}:ro`) || [],
          NetworkMode: 'none' // Disable network for security
        }
      });

      // Start container
      await container.start();

      // Collect output
      const stream = await container.logs({
        stdout: true,
        stderr: true,
        follow: true
      });

      let output = '';
      stream.on('data', (chunk) => {
        output += chunk.toString();
      });

      // Wait for stream to finish
      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
      });

      // Wait for container with timeout
      const timeout = options.timeout || 300000; // 5 minutes default
      const waitPromise = container.wait();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Container timeout')), timeout);
      });

      const result = (await Promise.race([waitPromise, timeoutPromise])) as any;

      return {
        success: result.StatusCode === 0,
        output: this.cleanDockerOutput(output),
        exitCode: result.StatusCode,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        exitCode: -1,
        duration: Date.now() - startTime
      };
    } finally {
      // Clean up
      if (container) {
        try {
          await container.remove({ force: true });
        } catch (cleanupError) {
          logger.warn(`Failed to remove container: ${cleanupError}`);
        }
      }
    }
  }

  /**
   * Ensure Docker image is available
   */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      // Image not found, pull it
      logger.info(`Pulling image: ${image}`);
      await new Promise((resolve, reject) => {
        this.docker.pull(image, (err: any, stream: any) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err: any) => {
            if (err) return reject(err);
            resolve(null);
          });
        });
      });
    }
  }

  /**
   * Clean Docker output (remove control characters)
   */
  private cleanDockerOutput(output: string): string {
    // Remove Docker stream headers (8 bytes per chunk)
    return output.replace(/[\x00-\x08]/g, '').trim();
  }
}
```

#### 3. Update Executor (`src/runner/executor.ts`)

```typescript
import { VMExecutor } from './vm-executor';

// At module level
let vmExecutor: VMExecutor | null = null;
let vmAvailable: boolean | null = null;

async function getVMExecutor(): Promise<VMExecutor | null> {
  if (vmAvailable === null) {
    vmExecutor = new VMExecutor();
    vmAvailable = await vmExecutor.isAvailable();
    if (!vmAvailable) {
      logger.warn('VM isolation not available (Docker not running). Falling back to host execution.');
      vmExecutor = null;
    }
  }
  return vmExecutor;
}

// In executeStep function, replace direct exec with VM execution
async function executeStep(step: Step, options: RunOptions): Promise<StepResult> {
  const startTime = Date.now();

  try {
    if (step.run) {
      // ... existing variable replacement code ...

      // Try VM execution first
      const vm = await getVMExecutor();
      if (vm && !options.disableVMIsolation) {
        logger.debug(`Executing in VM: ${command}`);

        const result = await vm.execute({
          command,
          workingDir: step['working-directory'] || '/workspace',
          env: {
            ...options.inputs,
            ...options.secrets,
          },
          timeout: 300000, // 5 minutes
        });

        if (result.output) {
          logger.info(result.output);
        }

        if (result.success) {
          logger.success(`Step completed: ${step.name || 'unnamed'}`);
        } else {
          logger.error(`Step failed: ${result.error || 'Unknown error'}`);
        }

        return {
          step,
          success: result.success,
          output: result.output,
          error: result.error,
          duration: result.duration,
        };
      }

      // Fallback to host execution
      logger.warn('Executing on host (VM isolation disabled or unavailable)');
      // ... existing execAsync code ...
    }
  }
}
```

#### 4. Add Configuration (`src/types/index.ts`)

```typescript
export interface RunOptions {
  dryRun?: boolean;
  inputs?: Record<string, string>;
  secrets?: Record<string, string>;
  job?: string;
  verbose?: boolean;
  disableVMIsolation?: boolean; // Allow users to opt-out
  vmImage?: string; // Custom Docker image
  vmTimeout?: number; // Execution timeout
}
```

#### 5. Update CLI (`src/cli.ts`)

```bash
actly workflow.yml --no-vm-isolation  # Disable VM isolation
actly workflow.yml --vm-image=node:20  # Use specific image
```

### Phase 2: Testing

#### Unit Tests (`src/runner/vm-executor.test.ts`)

```typescript
describe('VMExecutor', () => {
  it('should execute simple command in VM', async () => {
    const executor = new VMExecutor();
    const result = await executor.execute({
      command: 'echo "Hello from VM"'
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello from VM');
  });

  it('should handle command failures', async () => {
    const executor = new VMExecutor();
    const result = await executor.execute({
      command: 'exit 1'
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('should timeout long-running commands', async () => {
    const executor = new VMExecutor();
    const result = await executor.execute({
      command: 'sleep 10',
      timeout: 1000 // 1 second
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
```

### Phase 3: Documentation

Update README.md:

````markdown
## VM Isolation

actly executes workflows in isolated Docker containers by default for security:

- Each workflow step runs in a fresh container
- No access to host filesystem (except mounted paths)
- Network disabled by default
- Automatic cleanup after execution

**Requirements:**

- Docker installed and running
- User has Docker permissions

**Fallback:**
If Docker is not available, actly falls back to host execution with a warning.

**Disable VM isolation:**

```bash
actly workflow.yml --no-vm-isolation
```
````

````

## Implementation Effort

### Time Estimates
- VM Executor implementation: 8-10 hours
- Executor integration: 4-6 hours
- Testing: 4-6 hours
- Documentation: 2-3 hours
- **Total: 18-25 hours**

### Milestones
1. **Week 1**: VM executor with Docker support
2. **Week 2**: Integration with existing executor
3. **Week 3**: Testing and documentation
4. **Week 4**: Bug fixes and polish

## Security Considerations

### What VM Isolation Provides
✅ Process isolation
✅ Filesystem isolation
✅ Network isolation
✅ Resource limits (CPU, memory)
✅ Clean environment per execution

### What It Doesn't Provide
❌ Protection against malicious Docker images
❌ Protection if Docker daemon is compromised
❌ Kernel-level exploits (containers share kernel)

### Best Practices
1. Use official Docker images only
2. Keep Docker updated
3. Run Docker daemon as non-root
4. Use read-only mounts
5. Disable network unless needed
6. Set resource limits

## Alternatives Considered

### 1. Firecracker MicroVMs
- Pros: True VM isolation, fast startup
- Cons: Linux-only, complex setup, limited tooling
- Decision: Too complex for local development tool

### 2. gVisor
- Pros: Strong isolation, no privileged mode
- Cons: Limited syscall support, performance overhead
- Decision: Overkill for local testing

### 3. Host Execution Only
- Pros: Simplest, fastest
- Cons: No isolation, security risks
- Decision: Unacceptable for running untrusted actions

## Migration Path

### Backward Compatibility
- VM isolation is opt-in via configuration
- Existing workflows run unchanged (with warning)
- Host execution still available as fallback

### User Experience
```bash
# First run (Docker available)
$ actly workflow.yml
[INFO] Docker available, using VM isolation
[INFO] Pulling image: ubuntu:22.04
[INFO] Executing workflow in isolated container...

# First run (no Docker)
$ actly workflow.yml
[WARN] Docker not available, using host execution
[WARN] Security warning: Commands run directly on host
[INFO] Executing workflow on host...

# Opt-out
$ actly workflow.yml --no-vm-isolation
[INFO] VM isolation disabled
[INFO] Executing workflow on host...
````

## Conclusion

Docker-based VM isolation provides strong security boundaries while maintaining good performance for local testing. Implementation is straightforward using the dockerode library, and fallback to host execution ensures the tool works even without Docker.
