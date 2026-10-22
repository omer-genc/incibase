# incibase

Bun üzerinde çalışan, tek bir binary olarak dağıtılabilen backend-as-a-service. PocketBase'in "indir, çalıştır" sadeliğiyle Convex'in kod-öncelikli, uçtan uca tipli modelini birleştirir:

- **Zod şema → tablo + tip + JSON Schema.** `schema.ts` tek doğruluk kaynağı; SQLite tabloları, index'ler, TypeScript tipleri ve JSON Schema buradan üretilir.
- **Fonksiyonlar:** `query` (realtime, salt-okunur), `mutation` (transaction), `action` (dış dünya, `fetch`), `internal*` varyantları, HTTP route'ları.
- **Uçtan uca tipler:** `client.query(api.messages.list, { channel })` dönüş tipini sunucu koddan çıkarır; codegen kullanıcı kodunu çalıştırmaz, sadece dosya adlarından tip dosyası üretir.
- **Realtime:** WebSocket abonelikleri. Her sorgunun okuduğu aralık (index `eq`/aralık koşulları, `where` eşitlikleri, `get(id)`) kaydedilir; bir yazma yalnızca belgenin önceki ya da sonraki hâli o aralığa giriyorsa aboneliği yeniden çalıştırır. Yazma patlamaları 10 ms'lik pencerede birleştirilir, sonuç değişmediyse istemciye gönderilmez.
- **Auth** (e-posta/şifre, bearer token), **dosya depolama** (yerel disk veya S3; kayda bağlı `file()` alanları, private dosyalar, yükleme kısıtları, otomatik temizlik), **zamanlayıcı** (`ctx.scheduler`, cron), **otomatik migration**.
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

**Migration** her başlangıçta tek transaction içinde çalışır: yeni tablo/index oluşturulur, kaldırılan index silinir, bir tablonun şeması değiştiyse tüm dokümanlar yeniden doğrulanır (`.default()` ile eklenen alanlar yazılır). Şu durumlarda başlangıç reddedilir ve veritabanına dokunulmaz:

- Şema mevcut veriyle uyuşmuyor.
- Şema, dokümanlarda değeri olan bir alanı siliyor: alanı kaldırmak, yeniden adlandırmak (yeni ada `.default()` verilse bile) ya da iç içe bir nesneden veya dizideki nesnelerden anahtar çıkarmak. Hata tabloyu, alanı ve doküman sayısını listeler. Bu veriyi gerçekten silmek için `--allow-field-removal` ile başlat (`serve`, `dev`; kodda `EngineOptions.allowFieldRemoval`); silinen alanlar başlangıç çıktısında listelenir. Hiçbir dokümanda değeri olmayan bir alan bayraksız kaldırılabilir.
- Hiç şema yüklenmedi (ör. `schema.ts` eksik) ama veritabanında tablo var. Bütün tabloları bilerek kaldırmak için `export default defineSchema({})` yaz.

Şemadan kaldırılan tabloların verisi ve bu tabloların gösterdiği dosyalar silinmez. Dikkat: `.catch()` kullanan bir alanda, yeni şemaya uymayan kayıtlı değer uyarısız olarak `.catch()` değeriyle değiştirilir.

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
`ctx.storage`: `getUrl`, `getMetadata`, `generateUploadUrl`, `setVisibility`, `delete` (action'larda ayrıca `get`, `store`) — bkz. [Dosyalar ve erişim](#dosyalar-ve-erişim).
`ctx.scheduler`: `runAfter`, `runAt`, `cancel`; mutation içinde transaction'ın parçasıdır.

Mutation'lar sırayla, her biri ayrı bir SQLite transaction'ında çalışır; hata atarsa her şey geri alınır. Query'ler ayrı bir okuma bağlantısında son commit edilmiş snapshot'ı görür. İstemciye gitmesi gereken hatalar için `throw new IncibaseError({ code, message })`.

`crons.ts` (`cronJobs()` + `interval`/`cron`) ve `http.ts` (`httpRouter()` + `httpAction`) default export olarak tanınır.

## Dosyalar ve erişim

Bir kayda ait dosyalar için şemada `file()` kullan (PocketBase'deki dosya alanı gibi):

```ts
products: defineTable({
  name: z.string(),
  image: file({ maxBytes: 5_000_000, contentTypes: ["image/*"] }),
  invoice: file({ private: true, contentTypes: ["application/pdf"] }).optional(),
  gallery: z.array(file({ contentTypes: ["image/*"] })).default([]),
}),
```

- **Yazarken:** dosya yazanın kendi yüklemesi olmalı (admin/zamanlanmış görevler hariç) ve başka bir kayda bağlı olmamalı (`FORBIDDEN`, `FILE_IN_USE`). Alan kısıtları (`maxBytes`, `contentTypes`) burada da denetlenir. Elle `ownerId` kontrolüne gerek yok.
- **Okurken:** kaydı okuyabilen sorgu, kaydın dosyalarının linkini alır (`ctx.storage.getUrl`) — `private` olsa bile. Yalnızca dosya id'sini bilen başkası link alamaz. Yani **kayda erişen dosyaya erişir**; erişim kuralı sorgunun kendisidir.
- **Görünürlük alandan gelir:** `file({ private: true })` alanındaki dosyalar yalnızca imzalı, süreli linkle açılır (varsayılan 1 saat, `getUrl(id, { expiresIn })`). Public alanlar kalıcı, önbelleğe alınabilir link verir.
- **Temizlik:** alan değişince ya da kayıt silinince eski dosya ayrılır ve 1 saat sonra silinir; hiçbir kayda bağlanmayan yüklemeler 24 saat sonra silinir. `id("_storage")` alanlarının gösterdiği dosyalar ve bu özellikten önce yüklenmiş dosyalar silinmez. Ayar: `StorageOptions.cleanup` ya da `INCIBASE_STORAGE_CLEANUP=off`.
- Aynı dosyayı birden çok kayıtta kullanmak için `id("_storage")` (serbest referans) kullan; o durumda erişim kurallarını sahiplik ve `bypassOwnerCheck` ile kendin kurarsın.

### Yükleme ve kısıtlar

```ts
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    const user = await ctx.auth.requireUser();                       // kim yükleyebilir: sen karar verirsin
    if ((await ctx.storage.usage(user._id)).bytes > 500e6) throw new IncibaseError("Kota doldu"); // kota
    return ctx.storage.generateUploadUrl({ maxBytes: 10e6, contentTypes: ["image/*", "application/pdf"] });
  },
});
```

- Yükleme yalnızca bir mutation'ın ürettiği imzalı URL ile yapılabilir (1 saat geçerli); dolayısıyla **kimin** yükleyebileceğini o mutation belirler.
- URL'ye gömülen `maxBytes` / `contentTypes` sunucu tarafından yükleme anında denetlenir (`FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE`). PNG, JPEG, GIF, WebP ve PDF türü istemcinin söylediğine değil dosyanın baytlarına göre belirlenir.
- `ctx.storage.usage(userId)` kullanıcının dosya sayısını ve toplam boyutunu verir; kotayı uygulama belirler. Sunucu genelinde üst sınır `maxUploadBytes` (100 MB).
- Dosyalar `nosniff`, script çalıştırmayan bir CSP (`sandbox`) ve tarayıcıda gösterilemeyen türlerde `Content-Disposition: attachment` ile servis edilir; yüklenen bir HTML/SVG aynı origin'deki panele veya API'ye script çalıştıramaz.
- Sahiplik: dosyanın sahibi yükleme URL'sini isteyen kullanıcıdır (`generateUploadUrl({ ownerId })` ile başkası adına). Serbest `id("_storage")` referanslarında private dosyanın linki yalnızca sahibine verilir, `setVisibility`/`delete` yalnızca sahibine açıktır; erişimi kendin kontrol ettiysen `{ bypassOwnerCheck: true }`.

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
- Aynı query + args'ı kullanan bileşenler tek WebSocket aboneliğini paylaşır; unmount sonrası `keepAliveMs` (varsayılan 5000) kadar önbellekte kalır, geri dönünce sonuç anında gelir. `new IncibaseClient(url, { keepAliveMs: 0 })` hemen kapatır. Bu yüzden sayfalar arasında gezinirken paneldeki "Live subscriptions" sayısı geçici olarak artar.
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

## Admin paneli

Sunucu `/_/` adresinde bir yönetim paneli sunar (ör. `http://localhost:3210/_/`). Giriş için admin anahtarı gerekir: `incibase dev` açılışta yazdırır, aksi halde `incibase admin-key`.

- **Overview:** çalışma süresi, tablo başına doküman sayıları, fonksiyonlar, canlı abonelikler, son hatalar, uç noktalar (kopyalanabilir), Claude Code MCP komutu, cron'lar ve HTTP route'ları.
- **Data:** tablolar arasında gezinme, `alan = değer` filtresi, sıralama, sayfalama, canlı yenileme; dokümanı görüntüleme (alanlar / JSON), şemaya karşı doğrulanan düzenleme, onaylı silme, şemadan iskeletle yeni doküman, `_users` için yeni kullanıcı (test token'ı ile). Id alanları bağlı dokümanı açar (geri dönülebilir); `_storage` dokümanlarında dosya linki ve görsel önizleme.
- **Functions:** tüm fonksiyonlar (internal dahil), argüman tablosu (tip, zorunluluk, kısıtlar, varsayılan), JSON argümanla çalıştırma, bir kullanıcı adına çalıştırma, sonuç ve süre.
- **Logs:** fonksiyon çağrıları; tip, fonksiyon ve hata filtresi, canlı akış.
- **SQL:** salt-okunur SQL konsolu ve hazır örnekler. **Schema:** alanlar, referanslar, index'ler, JSON Schema.

Açık/koyu/sistem teması, mobil düzen ve sunucu takibi vardır: `dev` yeniden başlayınca şema ve fonksiyon listesi kendiliğinden yenilenir, sunucuya ulaşılamazsa uyarı çıkar.

Panel React + [shadcn/ui](https://ui.shadcn.com) + Tailwind v4 ile yazılmıştır (`src/dashboard/`) ve tek, kendi kendine yeten bir HTML dosyasına derlenip hem standalone binary'ye hem `incibase build` çıktısına gömülür; kaynaktan çalışırken ilk istekte derlenir. Kapatmak için `--no-dashboard`. Panelin kullandığı uç noktalar: `POST /api/admin/<araç>` (MCP admin araçlarıyla aynı uygulama, admin anahtarı ister). Yeni shadcn bileşeni eklemek için: `bunx shadcn@latest add <bileşen>`.

## Başka bir projede kullanmak

Paketi bağlama, ayrı repodan tipleri alma, React tekilleştirme ve diğer notlar: [docs/baska-projede-kullanim.md](docs/baska-projede-kullanim.md).

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

Bayraklar: `--dir` (incibase), `--data` (incibase_data), `--port` (3210 / `$PORT`), `--host`, `--url` (dışarıdan erişilen adres; dosya URL'leri için), `--outfile`, `--target`, `--no-dashboard`.

Ortam değişkenleri: `INCIBASE_ADMIN_KEY`, `INCIBASE_URL`, `INCIBASE_STORAGE=s3` (+ Bun'ın `S3_*` değişkenleri).

## Geliştirme

```bash
bun test            # motor, HTTP, realtime, auth, storage, scheduler, MCP, panel, React hook'ları
bun check           # test/types.check.ts tip çıkarımını da doğrular
bun run build:binary
bun run build:package  # npm paketinin dist/lib çıktısı
```

`example/incibase` tüm özellikleri kullanan örnek uygulamadır ve testler onu çalıştırır.

## Lisans

[MIT](LICENSE)
