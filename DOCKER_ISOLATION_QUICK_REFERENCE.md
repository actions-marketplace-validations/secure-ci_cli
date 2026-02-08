# Docker Container Isolation - Quick Reference

## 🎯 What We're Building

Transform actly from executing workflows on the host to running them in isolated Docker containers.

## 📊 Before vs After

### Before (Current)

```
┌─────────────────────────────────────────────────┐
│ User runs: actly workflow.yml                   │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ actly CLI                                        │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ executeWorkflow() → executeStep()               │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ child_process.exec()                             │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ HOST MACHINE (Full Access) ⚠️                   │
│ • Full filesystem access                         │
│ • Host privileges                                │
│ • Can modify system                              │
│ • No isolation                                   │
└─────────────────────────────────────────────────┘
```

### After (With Docker)

```
┌─────────────────────────────────────────────────┐
│ User runs: actly workflow.yml                   │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ actly CLI                                        │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│ executeWorkflow() → executeStep()               │
└───────────────────┬─────────────────────────────┘
                    │
                    ├─── Docker Available? ───┐
                    │                          │
                    ▼ YES                      ▼ NO
┌─────────────────────────────────┐  ┌────────────────────┐
│ DockerExecutor                  │  │ child_process.exec │
│ • Create container              │  │ (with warning)     │
│ • Execute command               │  └────────────────────┘
│ • Collect output                │
│ • Cleanup                       │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│ DOCKER CONTAINER (Isolated) ✅                   │
│ • Separate process namespace                     │
│ • Isolated filesystem                            │
│ • Network disabled                               │
│ • Memory limits                                  │
│ • Auto-cleanup                                   │
└─────────────────────────────────────────────────┘
```

## 🔑 Key Components

### 1. DockerExecutor Class

**File**: `src/runner/docker-executor.ts`

**Responsibilities**:

```typescript
class DockerExecutor {
  isAvailable(); // Check if Docker is running
  execute(options); // Run command in container
  pullImage(image); // Ensure image exists
  cleanup(container); // Remove container
}
```

### 2. Integration Points

**File**: `src/runner/executor.ts`

```typescript
async function executeStep(step, options) {
  if (step.run) {
    const docker = await getDockerExecutor(options);

    if (docker) {
      // Execute in Docker container
      return await docker.execute({ command, env, ... });
    } else {
      // Fallback to host (with warning)
      return await execAsync(command);
    }
  }
}
```

### 3. Configuration

**File**: `src/types/index.ts`

```typescript
interface RunOptions {
  useDocker?: boolean; // Enable/disable
  dockerImage?: string; // Custom image
  dockerTimeout?: number; // Timeout (ms)
  dockerMemoryLimit?: string; // Memory limit
}
```

## 📅 Implementation Timeline

```
Day 1 (4-6 hours)
├── Install dockerode
├── Create DockerExecutor class
├── Implement isAvailable()
└── Basic execute() method

Day 2 (6-8 hours)
├── Complete DockerExecutor
│   ├── Image pulling
│   ├── Output collection
│   ├── Timeout handling
│   └── Cleanup logic
├── Integrate with executor.ts
└── Add fallback mechanism

Day 3 (4-6 hours)
├── Unit tests (docker-executor.test.ts)
├── Integration tests
├── CLI flags (--no-docker, --docker-image)
└── Update README

Day 4 (2-3 hours)
├── Code review
├── Performance testing
├── Security review
└── Documentation polish
```

## 🔒 Security Benefits

| Feature           | Before              | After                  |
| ----------------- | ------------------- | ---------------------- |
| Process Isolation | ❌ Shared with host | ✅ Separate namespace  |
| Filesystem Access | ❌ Full host access | ✅ Isolated container  |
| Network Access    | ❌ Unrestricted     | ✅ Disabled by default |
| Resource Limits   | ❌ None             | ✅ CPU & memory caps   |
| Clean Environment | ❌ Shared state     | ✅ Fresh per step      |
| Privilege Level   | ❌ Host privileges  | ✅ Container user      |

## 💻 User Commands

```bash
# Standard usage (Docker auto-detected)
actly workflow.yml

# Disable Docker isolation
actly workflow.yml --no-docker

# Custom Docker image
actly workflow.yml --docker-image=node:20

# Set memory limit
actly workflow.yml --docker-memory=1g

# Set timeout (10 minutes)
actly workflow.yml --docker-timeout=600000
```

## 📋 Dependencies

### New Dependencies

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

### Docker Images Used

- `ubuntu:22.04` - Default for shell commands
- `node:20` - For JavaScript actions (node20)
- `node:22` - For JavaScript actions (node22)
- Custom images via `--docker-image` flag

## ⚡ Performance Targets

| Metric                  | Target       | Notes              |
| ----------------------- | ------------ | ------------------ |
| Container startup       | < 2 seconds  | After image cached |
| Image pull (first time) | < 30 seconds | ubuntu:22.04       |
| Overhead per step       | < 500ms      | Compared to host   |
| Memory overhead         | ~100MB       | Per container      |

## 🧪 Test Coverage

### Unit Tests

- Docker availability check
- Simple command execution
- Command failures
- Timeout handling
- Environment variables
- Custom images
- Error scenarios

### Integration Tests

- Full workflow execution in Docker
- Fallback to host execution
- Multi-step workflows
- JavaScript actions in Docker
- Composite actions in Docker

## ✅ Acceptance Criteria

- [ ] All existing tests pass
- [ ] Docker isolation working when Docker available
- [ ] Graceful fallback when Docker unavailable
- [ ] < 2 second container startup overhead
- [ ] Clear user messaging (info/warning logs)
- [ ] CLI flags working (--no-docker, --docker-image)
- [ ] Documentation updated
- [ ] No breaking changes
- [ ] Security review passed
- [ ] Code review approved

## 🚨 Common Issues & Solutions

### Issue: Docker Not Running

**Solution**: Auto-fallback to host with warning

```
[WARN] Docker daemon not available
[WARN] Falling back to host execution
[WARN] Install Docker for isolation: https://docs.docker.com/get-docker/
```

### Issue: Slow First Run

**Solution**: Image pulling with progress

```
[INFO] Pulling Docker image: ubuntu:22.04...
[INFO] Download complete (28MB)
[SUCCESS] Image ready
```

### Issue: Permission Denied

**Solution**: Clear instructions in error

```
[ERROR] Docker permission denied
[INFO] Run: sudo usermod -aG docker $USER
[INFO] Then logout and login again
```

## 📚 References

- **Docker SDK**: https://github.com/apocas/dockerode
- **GitHub Actions**: Uses Docker containers for isolation
- **Security Best Practices**: https://docs.docker.com/engine/security/

## 🎓 Implementation Notes

### Why dockerode?

- Industry standard Node.js Docker SDK
- Active maintenance (45k+ downloads/week)
- Comprehensive API coverage
- TypeScript support
- Used by major projects

### Why ubuntu:22.04?

- Official Ubuntu LTS image
- Well tested and secure
- Small size (~28MB compressed)
- Contains bash and common tools
- Matches GitHub Actions runner

### Why Graceful Fallback?

- Better user experience
- No hard Docker requirement
- Developers can test without Docker
- Clear warnings about security trade-offs

## 🔄 Migration Strategy

### Week 1: Soft Launch

- Docker optional, opt-in with `--use-docker`
- Default: host execution
- Gather user feedback

### Week 2: Default Enablement

- Docker enabled by default
- Auto-fallback if unavailable
- Documentation updated

### Week 3: Hardening

- Additional security options
- Performance optimization
- Advanced features (custom images, networks)

---

**Ready to Begin?** Review `DOCKER_ISOLATION_IMPLEMENTATION_PLAN.md` for detailed implementation steps.

**Questions?** Check open questions in Section 9 of the implementation plan.

**Status**: ✅ Plan complete, awaiting approval to start implementation
