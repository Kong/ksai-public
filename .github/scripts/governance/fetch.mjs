export function governedFetch(governor, upstream, origin) {
  return async (input, init) => {
    const target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return upstream(input, init);
    const url = new URL(target);
    if (!origin || url.origin !== origin) throw new Error('prompt governance admits no request to another origin');
    if (input instanceof Request && input.body) throw new Error("prompt governance cannot read a request object's body");
    if (!url.pathname.endsWith('/messages')) throw new Error(`prompt governance admits no request to ${url.pathname}`);
    const sent = { ...init, body: governor.guard(init?.body) };
    let response;
    try {
      response = await upstream(input, sent);
    } catch (error) {
      governor.failed();
      throw error;
    }
    return governor.follow(response);
  };
}
