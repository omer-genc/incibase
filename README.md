# incibase

Bun üzerinde çalışan, tek bir binary olarak dağıtılabilen backend-as-a-service. PocketBase'in "indir, çalıştır" sadeliğiyle Convex'in kod-öncelikli, uçtan uca tipli modelini birleştirir:

- **Zod şema → tablo + tip + JSON Schema.** `schema.ts` tek doğruluk kaynağı; SQLite tabloları, index'ler, TypeScript tipleri ve JSON Schema buradan üretilir.
- **Fonksiyonlar:** `query` (realtime, salt-okunur), `mutation` (transaction), `action` (dış dünya, `fetch`), `internal*` varyantları, HTTP route'ları.
- **Uçtan uca tipler:** `client.query(api.messages.list, { channel })` dönüş tipini sunucu koddan çıkarır; codegen kullanıcı kodunu çalıştırmaz, sadece dosya adlarından tip dosyası üretir.
- **Realtime:** WebSocket abonelikleri, yazılan tablolara göre yeniden çalışır, sonuç değişmediyse gönderilmez.
- **Auth** (e-posta/şifre, bearer token), **dosya depolama** (yerel disk veya S3), **zamanlayıcı** (`ctx.scheduler`, cron), **otomatik migration**.
- **MCP:** `/mcp` endpoint'i. `mcp: true` işaretli fonksiyonlar AI ajanlarına tool olur; admin anahtarıyla bağlanan ajan şemayı, veriyi ve logları görür.

## Hızlı başlangıç

```bash
bun add incibase zod        # editör tipleri için
bunx incibase init          # incibase/schema.ts + incibase/messages.ts
bunx incibase dev           # http://localhost:3210, dosya değişince yeniden başlar
```

Ya da standalone binary ile (node_modules gerekmez):

```bash
./incibase dev
```

## Şema

```ts
// incibase/schema.ts
import { defineSchema, defineTable, id, z } from "incibase/server";

export default defineSchema({
  channels: defineTable({
    name: z.string().min(1).max(50),
    createdBy: id("_users"),
  }).index("by_name", ["name"], { unique: true }),

  messages: defineTable({
    channel: id("channels"),
    author: id("_users"),
    body: z.string().min(1),
    pinned: z.boolean().default(false),
  }).index("by_channel", ["channel"]),
});
```

Her doküman `_id` ve `_creationTime` alır. `id("tablo")` yalnızca o tablonun id'lerini kabul eder (hem tip seviyesinde hem çalışma anında). Sistem tabloları: `_users`, `_storage`, `_scheduled` (salt-okunur).

**Migration** her başlangıçta tek transaction içinde çalışır: yeni tablo/index oluşturulur, kaldırılan index silinir, bir tablonun şeması değiştiyse tüm dokümanlar yeniden doğrulanır (`.default()` ile eklenen alanlar yazılır). Mevcut veriyle uyuşmayan bir şema reddedilir ve veritabanına dokunulmaz. Şemadan kaldırılan tabloların verisi silinmez.

## Fonksiyonlar

```ts
// incibase/messages.ts
import { id, IncibaseError, z } from "incibase/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: { channel: id("channels"), limit: z.number().max(200).default(50) },
  mcp: true, // AI ajanlarına tool olarak aç
  handler: (ctx, { channel, limit }) =>
    ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).order("desc").take(limit),
});

export const send = mutation({
  args: { channel: id("channels"), body: z.string().trim().min(1) },
  handler: async (ctx, args) => {
    const user = await ctx.auth.requireUser();
    const messageId = await ctx.db.insert("messages", { ...args, author: user._id });
    await ctx.scheduler.runAfter(0, internal.messages.notify, { messageId });
    return messageId;
  },
});
```

`ctx.db`: `get`, `query(...).withIndex/where/filter/order/collect/take/first/unique/paginate/count`, `insert`, `patch`, `replace`, `delete`.
`ctx.auth`: `getUserId`, `getUser`, `requireUser`, `isAdmin`.
`ctx.storage`: `getUrl`, `getMetadata`, `generateUploadUrl`, `delete` (action'larda ayrıca `get`, `store`).
`ctx.scheduler`: `runAfter`, `runAt`, `cancel`; mutation içinde transaction'ın parçasıdır.

Mutation'lar sırayla, her biri ayrı bir SQLite transaction'ında çalışır; hata atarsa her şey geri alınır. Query'ler ayrı bir okuma bağlantısında son commit edilmiş snapshot'ı görür. İstemciye gitmesi gereken hatalar için `throw new IncibaseError({ code, message })`.

`crons.ts` (`cronJobs()` + `interval`/`cron`) ve `http.ts` (`httpRouter()` + `httpAction`) default export olarak tanınır.

## İstemci

```ts
import { IncibaseClient } from "incibase/client";
import { api } from "../incibase/_generated/api";

const client = new IncibaseClient("http://localhost:3210");
await client.auth.signUp({ email: "a@b.co", password: "password123" });

const unsubscribe = client.subscribe(api.messages.list, { channel }, (messages) => render(messages));
await client.mutation(api.messages.send, { channel, body: "merhaba" });

const uploadUrl = await client.mutation(api.messages.generateUploadUrl);
const storageId = await client.storage.upload(uploadUrl, file);
```

### React

```tsx
import { IncibaseClient } from "incibase/client";
import { IncibaseProvider, useAuth, useMutation, usePaginatedQuery, useQuery } from "incibase/react";
import { api } from "../incibase/_generated/api";

const client = new IncibaseClient(import.meta.env.VITE_INCIBASE_URL ?? "http://localhost:3210");

export function App() {
  return (
    <IncibaseProvider client={client}>
      <Chat channel={channelId} />
    </IncibaseProvider>
  );
}

function Chat({ channel }: { channel: Id<"channels"> }) {
  const { user, signIn } = useAuth();
  const messages = useQuery(api.messages.list, { channel }); // undefined → yükleniyor, sonra canlı
  const send = useMutation(api.messages.send);
  const { results, status, loadMore } = usePaginatedQuery(api.messages.page, { channel }, { initialNumItems: 20 });
  // ...
}
```

- `useQuery(ref, args | "skip")`: canlı sonuç; hata error boundary'ye fırlatılır. Fırlatmayan sürüm: `useQueryResult` → `{ data, error, isLoading }`.
- Aynı query + args'ı kullanan bileşenler tek WebSocket aboneliğini paylaşır; unmount sonrası 5 sn önbellekte kalır.
- `usePaginatedQuery`: query `paginationOpts: paginationOptsValidator` almalı ve `.paginate(paginationOpts)` dönmeli. Sayfalar cursor zinciriyle bağlıdır; önceki sayfa değişirse sonraki onu takip eder (boşluk/tekrar olmaz).
- `useMutation`, `useAction`, `useAuth` (`user`, `isLoading`, `signIn`, `signUp`, `signOut`).
- `client.watchQuery(ref, args)` framework'ten bağımsız paylaşılan canlı query'dir (Vue/Svelte bağlamaları için temel).

HTTP API doğrudan da kullanılabilir: `POST /api/query|mutation|action` gövdesi `{ "path": "messages:list", "args": {...} }`, `Authorization: Bearer <token>`.

## MCP

Sunucu `/mcp` adresinde Streamable HTTP MCP sunar.

- Anonim/kullanıcı token'ı: `mcp: true` işaretli public fonksiyonlar (input şeması Zod'dan üretilir).
- Admin anahtarı: ek olarak `admin_schema`, `admin_list_documents`, `admin_get_document`, `admin_insert_document`, `admin_patch_document`, `admin_delete_document`, `admin_run_function`, `admin_sql` (salt-okunur), `admin_logs`, `admin_create_user`.

`incibase dev` açılışta Claude Code'a eklemek için gereken komutu yazar:

```bash
claude mcp add --transport http incibase http://localhost:3210/mcp --header "Authorization: Bearer <admin key>"
```

## Başka bir projede kullanmak

incibase henüz npm'de değil; paketi yerel olarak bağla:

```bash
cd /path/to/incibase && bun link      # bir kez
cd /path/to/projen && bun link incibase
```

**a) Backend aynı repoda (önerilen).** Projede `incibase/` klasörü olur, tipler `incibase/_generated/api`'den gelir:

```bash
bunx incibase init && bunx incibase dev
```

**b) Backend ayrı bir repoda çalışıyor.** Tipler o repodaki `incibase/_generated/api.ts`'de; bu dosya backend koduna yalnızca *tip* olarak bağlıdır, frontend bundle'ına sunucu kodu girmez. Frontend'in `tsconfig.json`'ına yol tanımı ekle:

```json
{ "compilerOptions": { "paths": { "@backend/*": ["../backend-repo/incibase/*"] } } }
```

Bun bu yolları kendisi çözer; Vite'ta aynı alias'ı `resolve.alias`'a da ekle. Sonra:

```ts
import { api } from "@backend/_generated/api";
```

Dikkat edilecekler:

- **Tek React kopyası:** `bun link` incibase'in kendi `node_modules/react`'ini de görür; iki kopya "Invalid hook call" hatası verir. Vite'ta `resolve: { dedupe: ["react", "react-dom"] }` ekle.
- **Tipsiz kullanım:** Tip dosyalarına erişim yoksa `import { anyApi } from "incibase"` → `client.query(anyApi.channels.list)`. Çalışır ama tip kontrolü yoktur.
- **Servisler arası çağrı:** `new IncibaseClient(url, { token: ADMIN_KEY })` ile internal fonksiyonlar da çağrılabilir. Admin anahtarını sadece sunucu tarafında kullan.
- **CORS** varsayılan olarak `*`; farklı port/domain'den bağlanmak ek ayar istemez.
- **Claude Code** diğer repodan da bağlanabilir: `claude mcp add --transport http incibase http://localhost:3210/mcp --header "Authorization: Bearer <admin key>"`.
- Paket şu an `.ts` kaynaklarını sunuyor (Bun ve Vite sorunsuz okur). npm'e yayınlamak için önce bir JS build adımı gerekir.

## Tek binary

```bash
bunx incibase build --outfile ./my-app                    # bu makine için
bunx incibase build --outfile ./my-app --target bun-linux-x64
./my-app --port 8080 --data ./data                        # node_modules yok, tek dosya
```

Standalone `incibase` binary'sinin kendisi: `bun run build:binary` → `dist/incibase`. Bu binary kullanıcı kodunu diskten yükler (`incibase`, `incibase/server`, `zod` import'ları binary'nin içindeki kopyalara yönlenir) ve `build` ile uygulamayı derleyebilir. Not: Bun 1.4'teki bir hata yüzünden standalone binary'den *aynı platform* için derleme PATH'te `bun` ister; başka platform hedefleri (`--target`) için gerekmez.

## Komutlar ve ayarlar

| Komut | |
| --- | --- |
| `dev` | Codegen + izleme + yeniden başlatma, `_generated/schema.json` yazar |
| `serve` | Sunucuyu çalıştırır (derlenmiş uygulamada varsayılan) |
| `codegen` | `_generated/{api,server,dataModel}.ts` |
| `build` | Tek çalıştırılabilir dosya |
| `init` | Başlangıç dosyaları |
| `admin-key` | Admin anahtarını yazdırır |

Bayraklar: `--dir` (incibase), `--data` (incibase_data), `--port` (3210 / `$PORT`), `--host`, `--url` (dışarıdan erişilen adres; dosya URL'leri için), `--outfile`, `--target`.

Ortam değişkenleri: `INCIBASE_ADMIN_KEY`, `INCIBASE_URL`, `INCIBASE_STORAGE=s3` (+ Bun'ın `S3_*` değişkenleri).

## Geliştirme

```bash
bun test            # motor, HTTP, realtime, auth, storage, scheduler, MCP, React hook'ları
bun check           # test/types.check.ts tip çıkarımını da doğrular
bun run build:binary
```

`example/incibase` tüm özellikleri kullanan örnek uygulamadır ve testler onu çalıştırır.
