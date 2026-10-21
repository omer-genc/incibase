// Compile-time checks for inferred types; `bun check` fails if any break.
import type { Id } from "incibase";
import { IncibaseClient } from "incibase/client";
import { api, internal } from "../example/incibase/_generated/api";
import type { Doc } from "../example/incibase/_generated/dataModel";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>() {}

const client = new IncibaseClient("http://localhost:3210");
declare const channel: Id<"channels">;

async function checks() {
  const messages = await client.query(api.messages.list, { channel });
  assert<Equal<(typeof messages)[number]["body"], string>>();
  assert<Equal<(typeof messages)[number]["pinned"], boolean>>();
  assert<Equal<(typeof messages)[number]["attachmentUrl"], string | null>>();
  assert<Equal<(typeof messages)[number]["_id"], Id<"messages">>>();

  const channels = await client.query(api.channels.list);
  assert<Equal<typeof channels, Doc<"channels">[]>>();

  const id = await client.mutation(api.messages.send, { channel, body: "hi" });
  assert<Equal<typeof id, Id<"messages">>>();

  const count = await client.query(api.stats.get, { key: "x" });
  assert<Equal<typeof count, number>>();

  const summary = await client.action(api.stats.summary);
  assert<Equal<typeof summary, { channels: number; messages: number }>>();

  // @ts-expect-error internal functions are not on `api`
  api.messages.bumpCount;
  internal.messages.bumpCount;
  // @ts-expect-error missing required arg
  await client.query(api.messages.list, {});
  // @ts-expect-error plain strings are not ids
  await client.query(api.messages.list, { channel: "abc" });
  // @ts-expect-error wrong arg type
  await client.mutation(api.messages.send, { channel, body: 1 });

  client.subscribe(api.messages.list, { channel, limit: 10 }, (rows) => {
    assert<Equal<(typeof rows)[number]["channel"], Id<"channels">>>();
  });
}
void checks;
