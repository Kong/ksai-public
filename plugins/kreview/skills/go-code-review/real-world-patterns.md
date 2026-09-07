# Real-World Go Patterns - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Source: <https://github.com/baz-scm/awesome-reviewers>

Patterns extracted from actual PR reviews in leading OSS projects. Each **Check For** is phrased
as a negative constraint — the condition that must actually hold before you flag, and what to
leave alone — so the pattern narrows a finding rather than inviting one on every diff. See
**When to Report / When to Skip** at the end.

## Testing

### Comprehensive Test Coverage (kubernetes/kubernetes)

**Check For:** Don't flag a suite with reasonable coverage; flag a new feature path, edge case, or negative scenario left with no test at all

**Pattern:**

- Every feature path has test case
- Edge cases explicitly tested
- Negative scenarios included
- Feature combinations validated

**Why:** Prevents regressions, ensures reliability

### Use Testify Assertion Libraries (vitessio/vitess)

**Check For:** Don't flag manual `if got != want` checks in a codebase that doesn't use testify; flag them where the project already standardizes on testify assert/require

**Anti-pattern:**

```go
if got != want {
    t.Errorf("got %v, want %v", got, want)
}
```

**Pattern:**

```go
assert.Equal(t, want, got)
require.NoError(t, err)
```

**Why:** Improved readability, better error messages, clearer intent

## Naming Conventions

### Consistent Descriptive Naming (prometheus/prometheus)

**Check For:** Don't flag terse-but-idiomatic names (`i`, `r`, `ctx`); flag a name that misleads or diverges from the codebase's established convention

**Pattern:**

- Descriptive over terse
- Consistent across codebase
- Reflects actual purpose
- Follows Go idioms

**Why:** Code clarity, reduced cognitive load

### Use Semantically Clear Names (kubernetes/kubernetes)

**Check For:** Don't flag a clear name; flag a generic `process`/`handle`/`data` identifier where a domain-specific name would say what it does

**Anti-pattern:**

```go
func process(data interface{}) error
func handle(item *Thing) error
```

**Pattern:**

```go
func validatePodSpec(spec *v1.PodSpec) error
func reconcileDeployment(deploy *apps.Deployment) error
```

**Why:** Self-documenting code, clear intent

### Follow Naming Patterns (temporalio/temporal)

**Check For:** Don't flag names matching the codebase's conventions; flag a command-less function, a noun-less type, or a boolean not reading as a predicate that breaks the pattern

**Pattern:**

- Commands for functions: `createUser`, `validateInput`
- Nouns for types: `UserManager`, `ConfigValidator`
- Adjectives for booleans: `isValid`, `hasPermission`
- Match domain language

**Why:** Consistency, predictability, domain alignment

## Code Organization

### Extract Reusable Functions (volcano-sh/volcano)

**Check For:** Don't flag two incidentally similar blocks; flag the same logic duplicated across 3+ sites where a single well-named function fits

**Pattern:**

- Identify repeated logic (3+ occurrences)
- Extract to well-named function
- Single responsibility
- Clear parameters

**Anti-pattern:**

```go
// Same logic repeated in multiple places
if err := validate(x); err != nil {
    return fmt.Errorf("validation failed: %w", err)
}
// ... later ...
if err := validate(y); err != nil {
    return fmt.Errorf("validation failed: %w", err)
}
```

**Pattern:**

```go
func validateAndWrap(val Validator) error {
    if err := val.Validate(); err != nil {
        return fmt.Errorf("validation failed: %w", err)
    }
    return nil
}
```

**Why:** DRY principle, maintainability, single source of truth

### Extract Repeated Code (grafana/grafana)

**Check For:** Don't flag incidental similarity or push toward over-abstraction; flag genuinely repeated blocks whose common behavior can be abstracted without hurting clarity

**Pattern:**

- Identify similar code blocks
- Abstract common behavior
- Preserve clarity
- Don't over-abstract

**Why:** Reduces duplication, easier updates, fewer bugs

### Simplify Code Structure (istio/istio)

**Check For:** Don't flag working custom code on taste; flag a hand-rolled routine the stdlib already provides, or deep nesting an early return would flatten

**Pattern:**

- Use stdlib functions over custom implementations
- Early returns over nested ifs
- Clear control flow
- Leverage Go idioms

**Why:** Less code, fewer bugs, better performance

## Performance

### Minimize Memory Allocations (prometheus/prometheus)

**Check For:** Don't flag allocations outside hot paths; flag a per-iteration allocation in a loop, or a buffer reallocated where `sync.Pool`/reuse/preallocation applies

**Pattern:**

- Reuse buffers via `sync.Pool`
- Preallocate slices/maps with known size
- Use efficient data structures
- Avoid repeated allocations in loops

**Example:**

```go
// Anti-pattern
for _, item := range items {
    buf := make([]byte, size) // allocates every iteration
    // use buf
}

// Pattern
buf := make([]byte, size)
for _, item := range items {
    buf = buf[:0] // reuse
    // use buf
}
```

**Why:** Reduces GC pressure, improves throughput

### Simplify Complex Algorithms (prometheus/prometheus)

**Check For:** Don't flag a clear implementation for not being clever; flag premature optimization or complexity added with no profiling data behind it

**Pattern:**

- Simple, clear implementation first
- Optimize only with profiling data
- Document complexity trade-offs
- Maintainability over cleverness

**Why:** Code clarity, easier debugging, prevents bugs

### Optimize Algorithmic Efficiency (volcano-sh/volcano)

**Check For:** Don't flag O(n²) on tiny/bounded inputs; flag a quadratic loop or wrong data structure on data that plausibly grows → a map lookup replaces the inner scan

**Pattern:**

- Choose appropriate data structures (map vs slice vs tree)
- Consider time complexity (O(n) vs O(n²))
- Avoid unnecessary iterations
- Use indexes for lookups

**Example:**

```go
// Anti-pattern: O(n²)
for _, item := range items {
    for _, target := range targets {
        if item.ID == target.ID { ... }
    }
}

// Pattern: O(n)
targetMap := make(map[string]*Target, len(targets))
for _, t := range targets {
    targetMap[t.ID] = t
}
for _, item := range items {
    if target, ok := targetMap[item.ID]; ok { ... }
}
```

**Why:** Scales better, faster execution

## Concurrency

### Prevent Concurrent Access Races (vitessio/vitess)

**Check For:** Don't flag goroutine-local or already-synchronized state; flag shared state read/written concurrently with no mutex, channel, or atomic guard

**Pattern:**

- Use `sync.Mutex` for shared state
- Channels for communication
- Atomic operations for simple counters
- Document locking strategy

**Anti-pattern:**

```go
type Counter struct {
    count int
}

func (c *Counter) Increment() {
    c.count++ // RACE
}
```

**Pattern:**

```go
type Counter struct {
    mu    sync.Mutex
    count int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}
```

**Why:** Prevents data races, ensures correctness

## Configuration

### Configuration Validation Consistency (traefik/traefik)

**Check For:** Don't flag config validated elsewhere; flag config accepted with no fail-fast `Validate()`, or a stringly-typed field where a duration/size/enum type fits

**Pattern:**

- Validate early (fail fast)
- Use appropriate types (duration, size, enum)
- Consistent error messages
- Document constraints

**Example:**

```go
type Config struct {
    Timeout time.Duration `yaml:"timeout"`
    MaxSize int64         `yaml:"max_size"`
}

func (c *Config) Validate() error {
    if c.Timeout <= 0 {
        return errors.New("timeout must be positive")
    }
    if c.MaxSize <= 0 {
        return errors.New("max_size must be positive")
    }
    return nil
}
```

**Why:** Catches errors early, clear feedback, type safety

## Documentation

### Add Explanatory Comments (istio/istio)

**Check For:** Don't flag self-explanatory code (over-commenting is its own noise); flag genuinely non-obvious logic (a workaround, a perf hack, a non-obvious rule) with nothing explaining WHY

**Pattern:**

- Comment WHY, not WHAT
- Explain non-obvious decisions
- Document edge cases
- Link to issues/design docs

**Example:**

```go
// Use exponential backoff with jitter to prevent thundering herd
// when multiple clients reconnect simultaneously after network partition.
// See: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
backoff := time.Duration(rand.Int63n(int64(baseDelay * (1 << attempt))))
```

**Why:** Maintainability, knowledge transfer, prevents rework

## Project Sources

- **kubernetes/kubernetes**: Comprehensive testing, semantic naming
- **prometheus/prometheus**: Performance optimization, naming consistency
- **vitessio/vitess**: Testify usage, concurrency safety
- **istio/istio**: Code simplification, documentation
- **grafana/grafana**: Code extraction, DRY principle
- **volcano-sh/volcano**: Algorithm optimization, function extraction
- **traefik/traefik**: Configuration validation
- **temporalio/temporal**: Naming patterns

## Usage in Reviews

**Priority Order:**

1. **Critical:** Concurrency races, configuration validation
2. **Major:** Testing quality, naming clarity, code duplication
3. **Minor:** Performance optimization, documentation, algorithm efficiency

**When to Report:**

- Pattern clearly applies
- Improvement measurable (readability, performance, correctness)
- Consistent with project style
- Not over-engineering

**When to Skip:**

- Pattern doesn't fit context
- Would reduce clarity
- Premature optimization
- Project has different conventions
