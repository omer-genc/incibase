# Başka bir projede kullanmak

incibase backend'i ayaktayken (`incibase dev`, `incibase serve` ya da derlenmiş binary) onu başka bir repodan nasıl kullanacağın.

Paketi kur:

```bash
bun add incibase zod
```

incibase'in kendisi üzerinde çalışırken yerel kopyayı bağlamak için: `cd /path/to/incibase && bun link`, sonra projende `bun link incibase`.

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

- **Tek React kopyası (yalnızca `bun link` ile):** bağlı kopya incibase'in kendi `node_modules/react`'ini de görür; iki kopya "Invalid hook call" hatası verir. Vite'ta `resolve: { dedupe: ["react", "react-dom"] }` ekle.
- **Vite HMR:** İstemciyi oluşturan modül hot-reload olursa yeni bir `IncibaseClient` oluşur ve eskisinin WebSocket'i açık kalır (kütüphane HMR'ı göremez). İstemciyi oluşturduğun dosyaya şunu ekle:
  ```ts
  export const client = new IncibaseClient(url);
  import.meta.hot?.dispose(() => client.close());
  ```
- **Tipsiz kullanım:** Tip dosyalarına erişim yoksa `import { anyApi } from "incibase"` → `client.query(anyApi.channels.list)`. Çalışır ama tip kontrolü yoktur.
- **Servisler arası çağrı (tek uygulama):** `incibase serve` `--admin-socket` olmadan çalışıyorsa `new IncibaseClient(url, { token: ADMIN_KEY })` ile internal fonksiyonlar da çağrılabilir. Admin anahtarını sadece sunucu tarafında kullan.
- **Servisler arası çağrı (hosted kurulum):** branch'ler `--admin-socket` ile çalışır ve public adres admin anahtarına 401 döner. Başka bir sunucu bir **servis anahtarı** kullanır: `new IncibaseClient(url, { token: SERVICE_KEY })`, anahtar `ik_svc_<id>_<secret>` biçimindedir.
  - Servis anahtarı admin değildir: `ctx.auth.isAdmin` false olur, fonksiyon kodu onu `ctx.auth.service` (`{ keyId, scopes }`) ile görür. `isAdmin`'e bakan httpAction'lar `ctx.auth.service`'e geçmeli.
  - Kapsamlar: `internal` (varsayılan) internal fonksiyonları çağırır; `impersonate` `x-incibase-as-user` ile bir kullanıcı adına çalışır; `upload` imzalı URL olmadan `/api/storage/upload`'a yükler; bu yolla yüklediği dosyaları (yalnızca kendi yüklediklerini) bir `file()` alanına bağlayabilir.
  - Branch anahtarların yalnızca sha256'sını `INCIBASE_SERVICE_KEYS_FILE` dosyasından okur: `[{ "id": "billing", "sha256": "<anahtarın sha256'sı, hex>", "scopes": ["internal"], "label": "faturalama", "revoked": false }]`. Dosya SIGHUP (`systemctl reload`) ile yeniden okunur; anahtar restart olmadan eklenir ya da iptal edilir.
- **CORS** varsayılan olarak `*`; farklı port/domain'den bağlanmak ek ayar istemez. İzin listesi için `INCIBASE_CORS_ORIGINS=https://shop.com,https://admin.shop.com`.
- **Claude Code** diğer repodan da bağlanabilir: `claude mcp add --transport http incibase http://localhost:3210/mcp --header "Authorization: Bearer <admin key>"`. Hosted kurulumda admin araçları yalnızca admin soketinde (SSH tüneli üzerinden) vardır; admin soketi de uygulamanın httpAction'larını ve dosyalarını sunmaz, onlar public adrestedir.
- `incibase`, `incibase/client` ve `incibase/react` derlenmiş ESM ve `.d.ts` olarak gelir; Node, Vite, Next.js ve Metro doğrudan kullanabilir. CLI (`incibase dev`, `serve`, `build`) Bun gerektirir.
