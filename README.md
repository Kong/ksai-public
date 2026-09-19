# ksai-public

The KSAI runtime, published here so a repository that cannot resolve `uses:` into an internal repository can still call it.

**Nothing here is edited by hand.** Every file is generated and the whole tree is overwritten on each release, so a change made here is lost at the next one.

**Pass your gateway origin as a secret before the first run.** This snapshot carries none of the hostnames the internal repository holds, so `ksai.yml` arrives with its `anthropic_base_url` default empty. An empty one is refused rather than falling back to Anthropic, which would take the spend off the gateway that attributes it, so until an origin is set every run stops in `run / gate`.

Pass it in the `secrets:` block of the job calling `ksai.yml`, not in `with:`:

```yaml
    secrets:
      model_gateway_url: ${{ secrets.KSAI_MODEL_GATEWAY_URL }}
```

A secret rather than an input or a variable, because this repository is public and GitHub prints every `with:` and `env:` value into the log, where anyone can read it. Passed as a secret, the origin is masked wherever it is echoed. The `anthropic_base_url` input still exists and still wins, for a repository whose origin is nobody's business to hide.

The value is an origin - it starts with `https://` and ends at the host, because every caller appends the version segment itself and a value ending in `/v1` is refused.

`ksai-request.yml` and `ksai-hold.yml` make no model call and take no such secret.

`suppressions_store` empties the same way. An empty one loads no suppressions and changes nothing else.
