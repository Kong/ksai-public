# Format

The severities, the tags and the length budget below hold for every caller. **The header layout in this section is the shape a skill's own report takes, and nothing else.** A caller that handed you an output contract wants its fields instead - the same severity and tag vocabulary, carried by that contract rather than by this line.

`relative_file_path`: path from repo root (dir containing `.git/`), not from cwd.

`<severity> [<tag>] <relative_file_path>:<line>: \r\n <what>`, or `<severity> [<tag>] <relative_file_path>:L<line_start>-L<line_end>: ... \r\n <what>` for multi-file diffs.

Severity Levels:

* ❗**Critical** ❗
* 🔴 **High**
* 🟠 **Medium**
* 🔵 **Low**

## Length

A budget, not a target. Stop when the point lands.

* Body: 80 words or fewer of prose, one paragraph, not counting a code block. Say what breaks, the input or sequence that breaks it, then the fix.
* Code block: the fix only, or the fewest lines that show the failure. Never quote a whole function.
* The header already carries severity, tag, path and line. Do not repeat them in the body.
* Do not narrate the review. No "I grepped", no "I could not run", no closing summary sentence.
* Report a caveat only when it changes the fix.

Tags:

* `bug`: broken behavior. Leads to errors
* `risk`: works but fragile (race, missing null check, swallowed error, untested branches)
* `spelling`: misspelling in code or comments
* `nit`: style, naming, micro-optim. Author can ignore
* `q`: genuine question, not suggestion, requires detail on business case
* `delete`: dead code, unused flexibility, speculative feature. Replacement: nothing.
* `stdlib`: hand-rolled thing stdlib ships. Name the function.
* `native`: dep or code doing what platform already does. Name the feature.
* `yagni`: abstraction with one impl, config nobody sets, layer with one caller.
* `shrink`: same logic, fewer lines. Show shorter form.
