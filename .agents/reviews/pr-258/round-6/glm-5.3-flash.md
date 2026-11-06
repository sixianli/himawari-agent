Good: rejection of threadOf covered (reports[2]). Sync-throw not covered but sync throw inside try is caught anyway — trivially equivalent.

Now let me also double-check `#egressContextFor` regarding "no signal": signal undefined → line 251 `signal?.aborted` — ok. cancelled promise never resolves; race with only threadOf. If request has no signal — is that possible? request.signal optional. Fine.

Edge: `signal?.aborted` check means a request cancelled between line 272 and 313 previously would still lookup (wasted work), now skip. No semantics change.

One more potential concern the author asked: "会不会改变已有的取消行为". Existing behavior at base f6829: `exchange()` with undefined context always (no egressContext in base? Actually base had `this.#egress.exchange()` — PR added egressContext). But relative to b9d90717 (prior round), #egressContextFor already existed without abort race; the race addition changes behavior only that an aborted-mid-lookup request proceeds sooner with base context and then is thrown at line 360. Same final outcome. Also new: skip lookup when signal already aborted — outcome identical.

Hmm — wait. Actually there's a subtle behavior difference worth flagging: when the race is lost to cancellation, the returned context is the base context (threadId null). The transport then proceeds to read prompt, resolve binding, etc. — a few awaits — before the throwIfAborted at line 360. If cancellation occurs not during the lookup but, e.g., after lookup won with threadId, that's unchanged. And `stream` never called due to line 360 throw. Yes.

Another subtlety: `cancelled` promise resolves null on abort even if threadOf already won the race — no, race already settled; irrelevant.

Now memory/duplicate: `stop` non-null always after executor — if executor throws? It can't (resolve only). fine.

Now Q3: 改动有没有对应的自动检查，反向用例真的会失败?
- runtime-pi [SI-2] cancel test: reverse case: if #egressContextFor didn't race (old behavior), lookup promise never resolves → collect hangs → outer 1000ms timer resolves "still waiting" → expect(["model.started","model.failed"]) fails. Also if lookup were not awaited at all... fine.
  But: does the test suite run this under time constraints? The test's poll must run "lookups" assertion — queueMicrotask abort. If listener not removed, wouldn't matter here.
- production composition [SI-2]: reverse: remove egressThreadOf passthrough in composition (line 337) or service-main wiring → threadId null → assertion fails. Author claims verified. I verified structurally: record's threadId comes solely from context.threadId (recorder line 70), and threadExists check passes only "thread-review" exists in threads.

Hmm — one caveat: if the composition layer's egressThreadOf were removed but service-main still wired... the test doesn't use service-main at all; it uses composition + productionEgressThreadOf directly. It tests that "composition → transport passes egressThreadOf correctly". If `createProductionModelComposition` dropped the passthrough (line 337), the test fails. But does it fail even though base context threadId null → recorder.observe called with threadId null → threadExists skipped (threadId null) → upsert with thread_id null → list returns threadId null → expected "thread-review" → fail. Yes.

Would the test also fail if service-main's own inline version changed scope fields (e.g., wrong agentId)? The test doesn't test service-main itself (service-main's createDefaultModelComposition isn't exercised — the test constructs options itself). So wiring inside service-main (line 300) has no test coverage: if service-main called productionEgressThreadOf with wrong args or dropped it, no test fails. Hmm — is there any other test of service-main composition? service-orchestration.unit.test.ts got +1 line. Let me check what that line is — maybe asserting productionEgressThreadOf is referenced? Let me check.
