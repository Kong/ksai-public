# Real-World NestJS Patterns - Code Review Reference

> **You cannot run any of this.** The reviewer holds no test runner, build, linter, formatter or package manager. A command named anywhere below describes what to look for in the tree under review, never something to execute. Where reading cannot settle a claim, say so in the finding.

Patterns distilled from the NestJS and TypeORM documentation, their issue trackers, and
production incident write-ups. Each pattern names the `knowledge-base.md` item(s) it
illustrates. These are the failure shapes that recur in real PRs — use them to recognize
the bug in unfamiliar code, and reuse the hunting checklists verbatim.

## State & Concurrency

### Singleton Providers Must Not Hold Per-Request State (cross-request leak)

Illustrates knowledge-base **#60** (and its cluster: #2, #3, #10, #62, #64). The NestJS
cardinal sin: providers are singletons by default, so an instance field written during
one request is visible to every concurrent request.

```typescript
// WRONG - currentUser is shared by every in-flight request
@Injectable()
export class ReportService {
  private currentUser: User; // one field, all requests

  async generate(user: User, reportId: string) {
    this.currentUser = user;               // request A writes
    const data = await this.load(reportId); // request B overwrites here
    return this.render(data);               // A renders with B's user
  }

  private render(data: ReportData) {
    return { ...data, requestedBy: this.currentUser.email }; // leaked
  }
}
```

```typescript
// RIGHT - pass per-request data through arguments (or ALS)
@Injectable()
export class ReportService {
  async generate(user: User, reportId: string) {
    const data = await this.load(reportId);
    return this.render(data, user);
  }

  private render(data: ReportData, user: User) {
    return { ...data, requestedBy: user.email };
  }
}
```

**Hunting checklist** — run this against every `@Injectable()` the diff touches:

1. List every instance field the diff adds or writes (`this.x = …`).
2. For each, ask: does the value derive from a request (user, org, params, body,
   headers, a per-call accumulator)? Config, clients, and construction-time state are
   fine.
3. If yes, is the provider request-scoped (`Scope.REQUEST`)? If not → **cross-request
   leak, Critical** when the data is tenant/user-bound; High otherwise.
4. If the provider IS request-scoped, check who injects it — the whole injector chain
   became request-scoped with it (#2): flag the hidden per-request instantiation cost on
   hot paths instead.
5. Evaluate the two dimensions independently: the *leak* (wrong data across requests)
   and the *lifetime growth* (an accumulator that never resets, #90). A clean verdict on
   one does not clear the other.

Two writes between which an `await` occurs are the proof: any interleaved request can
run in that window. Name the interleaving in the finding.

## Transactions

### Every Query in a Transaction Must Use the Transaction's Manager

Illustrates knowledge-base **#70** (TypeORM docs - transactions). The callback receives
a transactional `EntityManager`; queries through the injected repository silently run on
a separate pool connection, outside the transaction.

```typescript
// WRONG - repository call escapes the transaction
await this.dataSource.transaction(async (em) => {
  const order = await em.save(Order, dto);
  await this.inventoryRepo.decrement(       // injected repo: NOT in the tx
    { sku: dto.sku }, 'stock', dto.qty,
  );
  // if a later step throws, the order rolls back
  // but the stock decrement has already committed
});
```

```typescript
// RIGHT - everything goes through `em`
await this.dataSource.transaction(async (em) => {
  const order = await em.save(Order, dto);
  await em.getRepository(Inventory).decrement(
    { sku: dto.sku }, 'stock', dto.qty,
  );
});
```

Corollary (**#71**): `transaction(cb)` rolls back on a thrown error — a `try/catch`
inside the callback that swallows the error makes the partial state COMMIT. Rethrow
after handling, or the rollback never happens. When reviewing, trace every `catch`
inside a transaction callback to its rethrow.

Corollary (**#72**): a manual `createQueryRunner()` path needs
`finally { await queryRunner.release(); }` — count `createQueryRunner` calls against
`release` calls in the file.

## Validation

### `ValidationPipe` Without Whitelisting Is Mass Assignment

Illustrates knowledge-base **#34** + **#112** (NestJS docs - validation).

```typescript
// WRONG - unknown fields pass through and reach the entity
app.useGlobalPipes(new ValidationPipe());

@Post()
async create(@Body() dto: CreateUserDto) {
  return this.repo.save(dto); // body: { "email": "x@y.z", "isAdmin": true }
}                             // isAdmin was never in the DTO - saved anyway
```

```typescript
// RIGHT - strip (or reject) unknown fields, and never save the raw body
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));

@Post()
async create(@Body() dto: CreateUserDto) {
  return this.usersService.create(dto); // service maps DTO -> entity explicitly
}
```

Before flagging, read the actual global pipe options (`main.ts` and any `APP_PIPE`
provider) — a repo with `whitelist: true` globally clears most instances of this. The
nested variant (**#35**) survives whitelisting: a nested object without
`@ValidateNested() @Type(() => Child)` is skipped silently — grep new DTOs for object
properties and check both decorators are present.

## Serialization

### Sensitive Fields Leak When Responses Aren't Class Instances

Illustrates knowledge-base **#44** (NestJS docs - serialization).

```typescript
// WRONG - @Exclude only works on class instances
@Entity()
export class User {
  @Column() email: string;
  @Exclude() @Column() passwordHash: string;
}

@Get(':id')
@UseInterceptors(ClassSerializerInterceptor)
async find(@Param('id') id: string) {
  return this.repo
    .createQueryBuilder('u')
    .where('u.id = :id', { id })
    .getRawOne();               // plain object -> interceptor does nothing
}                               // passwordHash goes to the client
```

```typescript
// RIGHT - map to an explicit response DTO at the boundary
@Get(':id')
async find(@Param('id') id: string) {
  const user = await this.usersService.findById(id);
  return new UserResponseDto(user); // only the fields the contract names
}
```

When a finding claims a serialization leak, verify the return path end to end: entity
methods (`find*`) return instances (interceptor works); `getRaw*`, `.query()`, and
spread-copies (`{ ...user }`) return plain objects (interceptor is a no-op). The
explicit response DTO is the only shape that is safe by construction.

## Async Correctness

### The Floating-Promise Hunt

Illustrates knowledge-base **#54** / **#57** / **#49**.

```typescript
// WRONG - three ways the same bug hides
@OnEvent('order.created')
async handle(evt: OrderCreatedEvent) {
  this.audit.record(evt);              // 1. unawaited call - rejection escapes
  evt.items.forEach(async (item) => {  // 2. forEach never awaits
    await this.reserve(item);
  });
  return { ok: true };                 // returns before any reservation ran
}
```

```typescript
// RIGHT - await everything, bound the fan-out
@OnEvent('order.created')
async handle(evt: OrderCreatedEvent) {
  try {
    await this.audit.record(evt);
    for (const item of evt.items) {
      await this.reserve(item);        // or batched Promise.all for parallel
    }
  } catch (err) {
    this.logger.error({ err, orderId: evt.id }, 'order.created failed');
  }
}
```

**Hunting checklist:**

1. Grep the diff for `async (` inside `.forEach(`/`.map(` — a `.map` is only safe when
   its result feeds `await Promise.all(...)`.
2. Every call to an async method: is it `await`ed, `return`ed, or `.catch`ed? A bare
   `this.x()` where `x` is async is the finding — name what is lost (the error, the
   ordering, or both).
3. In `@OnEvent`/cron/consumer bodies (#97, #95): there is no exception filter out
   there. The handler's own try/catch is the only net — its absence plus any await is
   High.
4. `try { return this.service.do() }` without `await` (#51): the catch never fires.
   Prove it by asking what happens when the promise rejects after return.

## Testing

### A Behavioral e2e Test vs an Over-Mocked Unit

Illustrates knowledge-base **#99** / **#105** / **#106**.

```typescript
// WRONG - proves the mocks call each other
it('creates a user', async () => {
  const service = { create: jest.fn().mockResolvedValue({ id: '1' }) };
  const module = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [{ provide: UsersService, useValue: service }],
  }).compile();

  const result = await module.get(UsersController).create(dto);
  expect(service.create).toHaveBeenCalledWith(dto); // tests the mock
  expect(result).toBeDefined();                     // cannot fail
});
```

```typescript
// RIGHT - exercises routing, validation, serialization, and the contract
it('creates a user and never returns the password hash', async () => {
  await request(app.getHttpServer())
    .post('/users')
    .send({ email: 'a@b.co', password: 'hunter22' })
    .expect(201)
    .expect(({ body }) => {
      expect(body.email).toBe('a@b.co');
      expect(body.passwordHash).toBeUndefined(); // the assertion that matters
    });
});
```

### The e2e App Must Mirror the Production Pipeline

Illustrates knowledge-base **#104** — the highest-yield e2e review check, because the
suite passes while proving the wrong thing.

```typescript
// WRONG - no global pipe: e2e accepts what prod rejects
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
});
```

```typescript
// RIGHT - re-apply exactly what main.ts applies (extract a shared setup fn)
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  applyAppConfig(app); // same fn main.ts calls: pipes, filters, prefix, versioning
  await app.init();
});

afterAll(async () => {
  await app.close(); // #103 - or the suite leaks open handles
});
```

When reviewing e2e changes, diff the test bootstrap against `main.ts`: every
`useGlobal*`, `setGlobalPrefix`, and `enableVersioning` call missing from the test setup
is a divergence the suite silently ignores.

### Assert Negative and Error Paths, Not Just Happy Path

Illustrates knowledge-base **#100** / **#101** / **#106**.

```typescript
// The minimum negative set for a guarded, validated endpoint
it('rejects an unauthenticated request', () =>
  request(app.getHttpServer()).post('/orders').send(valid).expect(401));

it("rejects another org's resource", () =>
  request(app.getHttpServer())
    .get(`/orders/${otherOrgOrderId}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(404)); // or 403 - assert whichever the contract states

it('rejects an invalid payload with field detail', () =>
  request(app.getHttpServer())
    .post('/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...valid, qty: 0 })
    .expect(400)
    .expect(({ body }) => expect(body.detail).toContain('qty')));
```

A suite where every request carries a valid token and a valid body — or where
`overrideGuard` returns `true` in every file — has zero authz coverage regardless of its
test count. Flag the *absence* with the specific missing case, not "add more tests".

## Usage in Reviews

Cite the knowledge-base item number and, where one applies, the pattern section here
(e.g. "#70 — see real-world-patterns 'Transactions'"). Reuse the hunting checklists
verbatim rather than improvising: they encode the reachability checks that keep these
findings out of false-positive territory. When a pattern's WRONG shape appears but its
context differs (e.g. a singleton field that is genuinely construction-time config),
say why it does not apply instead of flagging on shape alone.
