import { httpRouter } from "incibase/server";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/hello",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const name = new URL(req.url).searchParams.get("name") ?? "world";
    const channels = await ctx.runQuery(api.channels.list);
    return Response.json({ hello: name, channels: channels.length });
  }),
});

export default http;
