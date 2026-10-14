# Unsafe Rust - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, Miri, sanitizer or package manager. A tool named below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Read this guide only when the diff adds or changes `unsafe` code, or changes an invariant that an `unsafe` block in the same file relies on. Find the `unsafe` blocks, `unsafe fn`, `unsafe impl` and `unsafe trait` items the change touches, and the safe code that builds their invariants. These checks are the ones the shipped `unsafe-rust-review` playbook runs, so a routed review and that playbook never disagree on a rule.

## First: does it need to be unsafe

For each `unsafe` the change adds, ask whether safe Rust does the same job at the same cost: a slice method instead of pointer arithmetic, the `MaybeUninit` API instead of `mem::uninitialized`, a checked cast instead of `transmute`, an index the optimiser already proves in bounds. When safe code would do, report it as `Low` with the `stdlib` tag and name the safe API, unless the unsafe version is also wrong.

## Then: is it sound

Prove each block sound from the code you can read, or report what breaks it. Check at least:

- Validity: every reference points to live, aligned, initialised memory of the right type for its whole lifetime. No reference to uninitialised or padding bytes, no `&mut` that aliases another reference, no shared reference to memory something else writes.
- Pointers: arithmetic stays inside one allocation or one past its end, `offset` and `add` never overflow `isize`, a null or dangling pointer is never dereferenced, and alignment holds for every read and write.
- Lengths and bounds: `get_unchecked`, `set_len`, `from_raw_parts` and `copy_nonoverlapping` get indices and lengths that are proven in range on every path, empty inputs included.
- Lifetimes: a pointer or a reference made from a `Box`, `Vec`, `String` or a stack value does not outlive it, and nothing reads a value after it is dropped, forgotten or moved.
- `transmute` and casts: source and target have the same size, the bit pattern is valid for the target, and every layout the cast relies on carries `#[repr(C)]` or `#[repr(transparent)]`.
- FFI: the foreign signature matches, one side alone owns and frees each allocation, strings are NUL-terminated where C expects them, a callback cannot unwind across the boundary, and the foreign function's own preconditions hold.
- `Send` and `Sync`: a manual `unsafe impl` holds for every field, raw pointers and interior mutability included.
- Panic safety: no panic leaves a broken invariant observable, such as a `Vec` whose length passes its initialised elements, or a double drop after a partial move.
- Concurrency: atomics use orderings strong enough for the data they publish, and no data race reaches non-atomic memory.
- The safe API around it: a caller that uses only safe code cannot reach undefined behaviour through it. A public safe function that relies on an unchecked precondition is unsound even when every caller today is careful.
- Documentation: each `unsafe` block carries a `// SAFETY:` comment that names the invariant it relies on, and each `unsafe fn` documents its preconditions under `# Safety`. A missing or wrong one is a `low` finding by itself, and raises a soundness finding beside it.

## Severity

Take the severity from the consequence you can show, on the `format_policy` scale:

- `Critical`, tag `bug`: undefined behaviour that any caller or input reaches, such as an out-of-bounds write.
- `High`, tag `bug`: undefined behaviour under a reachable edge case, such as an empty input or a concurrent caller.
- `Medium`, tag `risk`: unsound only through a misuse the safe API allows, or a hole the next change is likely to open.
- `Low`: unsafe code that safe code would replace (tag `stdlib`), or a missing or wrong safety comment (tag `risk`).

Anchor each finding to the line of the `unsafe` block or item it is about. Name the input or sequence that breaks the invariant, why nothing stops it, and the smallest change that makes it sound.
