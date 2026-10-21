/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Id } from "incibase";
import { IncibaseClient } from "incibase/client";
import {
  IncibaseProvider,
  useAuth,
  useMutation,
  usePaginatedQuery,
  useQuery,
  useQueryResult,
} from "incibase/react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../example/incibase/_generated/api";
import { memoryStorage, startTestServer } from "./helpers.ts";

// Only the DOM globals React needs: the test server runs in this process and
// must keep Bun's own Response/fetch/WebSocket.
const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const dom = new Window();

let t: Awaited<ReturnType<typeof startTestServer>>;
let writer: IncibaseClient;
const roots: Root[] = [];

beforeAll(async () => {
  t = await startTestServer();
  writer = newClient();
  await writer.auth.signUp({ email: "writer@example.com", password: "password123" });
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });
});

afterAll(async () => {
  for (const root of roots) root.unmount();
  await t.stop();
  await dom.happyDOM.close();
});

function newClient() {
  return new IncibaseClient(t.url, { tokenStorage: memoryStorage(), fetch: realFetch, WebSocket: RealWebSocket });
}

async function render(client: IncibaseClient, children: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  root.render(createElement(IncibaseProvider, { client }, children));
  return { container, root };
}

/** Polls `check` until it passes; updates arrive asynchronously over the WebSocket. */
async function waitFor(check: () => void, timeoutMs = 3000) {
  const started = Date.now();
  while (true) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await Bun.sleep(15);
    }
  }
}

async function newChannel(name: string) {
  return writer.mutation(api.channels.create, { name });
}

describe("useQuery", () => {
  test("renders loading, then data, then live updates", async () => {
    const channel = await newChannel("react-live");
    const renders: (string[] | undefined)[] = [];
    function Messages() {
      const messages = useQuery(api.messages.list, { channel });
      renders.push(messages?.map((m) => m.body));
      return createElement("ul", null, messages?.map((m) => createElement("li", { key: m._id }, m.body)));
    }
    const { container } = await render(newClient(), createElement(Messages));
    await waitFor(() => expect(renders.length).toBeGreaterThan(0));
    expect(renders[0]).toBeUndefined();
    await waitFor(() => expect(renders.at(-1)).toEqual([]));

    await writer.mutation(api.messages.send, { channel, body: "hello from react" });
    await waitFor(() => expect(container.textContent).toBe("hello from react"));
  });

  test("components with the same query share one server subscription", async () => {
    const channel = await newChannel("react-shared");
    const before = t.engine.realtime.subscriptionCount;
    function Count() {
      return createElement("span", null, String(useQuery(api.messages.list, { channel })?.length ?? "…"));
    }
    const { container } = await render(newClient(), [createElement(Count, { key: 1 }), createElement(Count, { key: 2 })]);
    await waitFor(() => expect(container.textContent).toBe("00"));
    expect(t.engine.realtime.subscriptionCount).toBe(before + 1);
  });

  test("skip runs nothing and useQueryResult reports errors inline", async () => {
    function Probe() {
      const skipped = useQueryResult(api.messages.list, "skip");
      const bad = useQueryResult(api.messages.list, { channel: "not-an-id" as Id<"channels"> });
      return createElement(
        "p",
        null,
        `${skipped.isLoading}|${skipped.data}|${bad.isLoading}|${bad.error ? "error" : "none"}`,
      );
    }
    const { container } = await render(newClient(), createElement(Probe));
    await waitFor(() => expect(container.textContent).toBe("false|undefined|false|error"));
  });
});

describe("useAuth and useMutation", () => {
  test("signing in updates useAuth and authorizes mutations", async () => {
    const channel = await newChannel("react-auth");
    let actions: { signIn: ReturnType<typeof useAuth>["signIn"]; send: ReturnType<typeof useMutation<typeof api.messages.send>> };
    function App() {
      const auth = useAuth();
      const send = useMutation(api.messages.send);
      actions = { signIn: auth.signIn, send };
      const messages = useQuery(api.messages.list, { channel });
      return createElement("p", null, `${auth.isLoading ? "loading" : (auth.user?.email ?? "anonymous")}:${messages?.length ?? "…"}`);
    }
    const { container } = await render(newClient(), createElement(App));
    await waitFor(() => expect(container.textContent).toBe("anonymous:0"));

    await actions!.signIn({ email: "writer@example.com", password: "password123" });
    await waitFor(() => expect(container.textContent).toBe("writer@example.com:0"));

    await actions!.send({ channel, body: "from a hook" });
    await waitFor(() => expect(container.textContent).toBe("writer@example.com:1"));
  });
});

describe("usePaginatedQuery", () => {
  test("loads pages on demand and follows live inserts", async () => {
    const channel = await newChannel("react-pages");
    for (let i = 0; i < 7; i++) await writer.mutation(api.messages.send, { channel, body: `m${i}` });

    let loadMore: (n: number) => boolean = () => false;
    function List() {
      const result = usePaginatedQuery(api.messages.page, { channel }, { initialNumItems: 3 });
      loadMore = result.loadMore;
      return createElement("p", null, `${result.status}:${result.results.map((m) => m.body).join(",")}`);
    }
    const { container } = await render(newClient(), createElement(List));
    await waitFor(() => expect(container.textContent).toBe("CanLoadMore:m0,m1,m2"));

    loadMore(3);
    await waitFor(() => expect(container.textContent).toBe("CanLoadMore:m0,m1,m2,m3,m4,m5"));

    loadMore(3);
    await waitFor(() => expect(container.textContent).toBe("Exhausted:m0,m1,m2,m3,m4,m5,m6"));
    expect(loadMore(3)).toBe(false);

    await writer.mutation(api.messages.send, { channel, body: "m7" });
    await waitFor(() => expect(container.textContent).toBe("Exhausted:m0,m1,m2,m3,m4,m5,m6,m7"));
  });

  test("deleting inside an early page shifts later pages without gaps", async () => {
    const channel = await newChannel("react-shift");
    const ids: Id<"messages">[] = [];
    for (let i = 0; i < 6; i++) ids.push(await writer.mutation(api.messages.send, { channel, body: `m${i}` }));

    let loadMore: (n: number) => boolean = () => false;
    function List() {
      const result = usePaginatedQuery(api.messages.page, { channel }, { initialNumItems: 2 });
      loadMore = result.loadMore;
      return createElement("p", null, result.results.map((m) => m.body).join(","));
    }
    const { container } = await render(newClient(), createElement(List));
    await waitFor(() => expect(container.textContent).toBe("m0,m1"));
    loadMore(2);
    await waitFor(() => expect(container.textContent).toBe("m0,m1,m2,m3"));

    // Remove m1 directly; page 1 refills with m2 and page 2 moves along.
    await t.engine.writeTx((s) => s.delete(ids[1]!));
    await waitFor(() => expect(container.textContent).toBe("m0,m2,m3,m4"));
  });
});
