// Compile-time checks for the React hooks' inferred types.
import type { Id } from "incibase";
import { useAction, useMutation, usePaginatedQuery, useQuery, useQueryResult } from "incibase/react";
import { api } from "../example/incibase/_generated/api";
import type { Doc } from "../example/incibase/_generated/dataModel";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>() {}
declare const channel: Id<"channels">;

export function Component() {
  const channels = useQuery(api.channels.list);
  assert<Equal<typeof channels, Doc<"channels">[] | undefined>>();

  const messages = useQuery(api.messages.list, { channel, limit: 5 });
  assert<Equal<NonNullable<typeof messages>[number]["body"], string>>();
  useQuery(api.messages.list, "skip");
  // @ts-expect-error channel is required
  useQuery(api.messages.list, {});

  const { data, error } = useQueryResult(api.stats.get, { key: "messages" });
  assert<Equal<typeof data, number | undefined>>();
  assert<Equal<typeof error, Error | undefined>>();

  const send = useMutation(api.messages.send);
  assert<Equal<ReturnType<typeof send>, Promise<Id<"messages">>>>();
  // @ts-expect-error body is required
  void send({ channel });

  const summary = useAction(api.stats.summary);
  assert<Equal<Awaited<ReturnType<typeof summary>>, { channels: number; messages: number }>>();

  const { results, status, loadMore } = usePaginatedQuery(api.messages.page, { channel }, { initialNumItems: 10 });
  assert<Equal<(typeof results)[number], Doc<"messages">>>();
  assert<Equal<typeof status, "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted">>();
  loadMore(10);
  // @ts-expect-error not a paginated query
  usePaginatedQuery(api.messages.list, { channel }, { initialNumItems: 10 });
  // @ts-expect-error paginationOpts is filled in by the hook
  usePaginatedQuery(api.messages.page, { channel, paginationOpts: { cursor: null, numItems: 1 } }, { initialNumItems: 10 });

  return null;
}
