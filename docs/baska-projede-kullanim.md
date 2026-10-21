# Başka bir projede kullanmak

incibase backend'i ayaktayken (`incibase dev`, `incibase serve` ya da derlenmiş binary) onu başka bir repodan nasıl kullanacağın.

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
- **Vite HMR:** İstemciyi oluşturan modül hot-reload olursa yeni bir `IncibaseClient` oluşur ve eskisinin WebSocket'i açık kalır (kütüphane HMR'ı göremez). İstemciyi oluşturduğun dosyaya şunu ekle:
  ```ts
  export const client = new IncibaseClient(url);
  import.meta.hot?.dispose(() => client.close());
  ```
- **Tipsiz kullanım:** Tip dosyalarına erişim yoksa `import { anyApi } from "incibase"` → `client.query(anyApi.channels.list)`. Çalışır ama tip kontrolü yoktur.
- **Servisler arası çağrı:** `new IncibaseClient(url, { token: ADMIN_KEY })` ile internal fonksiyonlar da çağrılabilir. Admin anahtarını sadece sunucu tarafında kullan.
- **CORS** varsayılan olarak `*`; farklı port/domain'den bağlanmak ek ayar istemez.
- **Claude Code** diğer repodan da bağlanabilir: `claude mcp add --transport http incibase http://localhost:3210/mcp --header "Authorization: Bearer <admin key>"`.
- Paket şu an `.ts` kaynaklarını sunuyor (Bun ve Vite sorunsuz okur). npm'e yayınlamak için önce bir JS build adımı gerekir.
