# Docker Actions Implementation Plan

## Objective

Enable actly to fetch and execute Docker-based GitHub Actions in isolated containers.

## Prerequisites

- Docker daemon running on host
- `dockerode` npm package (Docker SDK for Node.js)

## Implementation Steps

### 1. Update Dependencies

```bash
npm install dockerode @types/dockerode
```

### 2. Create Docker Executor (`src/runner/docker-executor.ts`)

```typescript
import Docker from 'dockerode';

export async function executeDockerAction(
  actionDir: string,
  image: string,
  inputs: Record<string, string>,
  entrypoint?: string,
  args?: string[]
): Promise<{ success: boolean; output: string }> {
  const docker = new Docker();

  // Pull image if needed
  try {
    logger.info(`Pulling Docker image: ${image}`);
    await docker.pull(image);
  } catch (error) {
    return {
      success: false,
      output: `Failed to pull image ${image}: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }

  // Prepare environment variables
  const env = Object.entries(inputs).map(
    ([k, v]) => `INPUT_${k.toUpperCase().replace(/-/g, '_')}=${v}`
  );

  let container;
  try {
    // Create and start container
    container = await docker.createContainer({
      Image: image,
      Env: env,
      Entrypoint: entrypoint,
      Cmd: args,
      AttachStdout: true,
      AttachStderr: true
    });

    await container.start();

    // Wait and collect output
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true
    });

    let output = '';
    stream.on('data', (chunk) => {
      output += chunk.toString();
    });

    // Wait for stream to finish before waiting for container
    await new Promise<void>((resolve) => {
      stream.on('end', resolve);
    });

    await container.wait();

    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: `Container execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  } finally {
    // Clean up container
    if (container) {
      try {
        await container.remove();
      } catch (cleanupError) {
        logger.warn(
          `Failed to remove container: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`
        );
      }
    }
  }
}
```

### 3. Update `executor.ts`

In the `executeAction` function, replace Docker skip logic:

```typescript
} else if (action.runs.using === 'docker') {
  logger.info(`Executing Docker action: ${action.name}`);

  const image = action.runs.image;
  if (!image) {
    return { step, success: false, error: 'No image specified' };
  }

  const inputs = step.with || {};
  const result = await executeDockerAction(
    actionDir,
    image,
    inputs,
    action.runs.entrypoint,
    action.runs.args
  );

  return { step, success: result.success, output: result.output };
}
```

### 4. Add Tests (`src/runner/docker-executor.test.ts`)

```typescript
describe('Docker Executor', () => {
  it('should execute Docker action with inputs', async () => {
    // Mock Docker container
    // Test input passing via environment variables
    // Verify output collection
  });

  it('should handle Docker image pull failures', async () => {
    // Test network/image errors
  });
});
```

### 5. Error Handling

- Check Docker daemon availability: `docker.ping()`
- Handle image pull failures gracefully
- Timeout long-running containers (configurable)
- Clean up containers on failure

### 6. Configuration

Add to `RunOptions`:

```typescript
export interface RunOptions {
  // ... existing options
  dockerTimeout?: number; // Default: 300 seconds
  dockerPullPolicy?: 'always' | 'if-not-present' | 'never';
}
```

## Testing Strategy

1. Unit tests with mocked Docker API
2. Integration tests with real Docker (skip in CI if Docker unavailable)
3. Test cases:
   - Basic Docker action execution
   - Custom entrypoint and args
   - Input/output handling
   - Error scenarios (missing image, daemon down)

## Estimated Effort

- Implementation: 4-6 hours
- Testing: 2-3 hours
- Documentation: 1 hour

## Fallback

If Docker is not available, gracefully skip with warning (current behavior).
