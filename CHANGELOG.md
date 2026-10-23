# Değişiklikler

## Unreleased

M1 Faz B: tek sunucuda birden fazla proje ve branch barındıran host katmanı. Tasarım: [docs/m1-mimari.md](docs/m1-mimari.md), kurulum ve işletim rehberi: [docs/host.md](docs/host.md). Tek uygulama `serve`/`dev` değişmedi.

### Yeni

- **Host CLI** (sunucuda root olarak): `host init|add-admin|render|status|doctor|check|gc|install-runtime|use-cli|runtimes|set|tls`, `project`, `branch`, `release`, `env`, `service-key`, hosted `admin-key`, `status`, `logs`. Kontrol düzlemi root'a ait bir SQLite registry; daemon yok. Çıkış kodları 0 tamam, 1 başarısız, 2 kullanım.
- **Branch başına izolasyon.** Her branch kendi OS kullanıcısıyla (`ib-<id>`) ayrı bir systemd unit'inde, sandbox'ta ve `incibase.slice` altında koşar; bellek, CPU, PID, veritabanı ve depolama sınırları branch başına. Adresler `https://<branch>--<project>.<domain>`.
- **Ön kapı nginx.** Unix soketlere yönlendirme, TLS (Cloudflare Origin CA dahil, `host tls` ile rotation), `trust_proxy cloudflare`, rate limit'ler, admin yollarının public'te 404'ü, restart sırasında `503` + `x-incibase-unprocessed`.
- **Release akışı.** `release add` (dosyadan ya da stdin'den); prod'da branch'in kendi kullanıcısıyla alınan snapshot, verinin kopyasında preflight, restart ve health gate; başarısızlıkta otomatik geri dönüş. `release rollback [--to] [--restore] [--snapshot]`.
- **Runtime pinleme.** Runtime'lar `SHA256SUMS` ile doğrulanarak kurulur (`host install-runtime`), her branch bir sürüme pinlenir, `branch upgrade` snapshot, preflight ve gate ile yükseltir; GitHub Release'e `SHA256SUMS` eklenir.
- **Check timer ve alarmlar.** 30 s'de bir health, takılan branch'i öldürme, `failed` unit'i bir kez yeniden deneme, disk eşikleri; alarmlar `host set alert_webhook` ile (ör. ntfy.sh). `host doctor` host'un dayandığı her şeyi OK/WARN/FAIL olarak denetler.
- **Admin yalnızca SSH ile.** Laptopta `incibase tunnel <project>/<branch> --ssh <host>` dashboard'u ve MCP'yi branch'in admin soketine tüneller; `host add-admin` hesabı admin grubuna ekler.
- **Sırlar ve servis anahtarları.** `env import … -` sırları stdin'den alır; servis anahtarları yalnızca sha256'larıyla tutulur ve restart'sız iptal edilir.

### Bilinen sınırlar

- Ubuntu 24.04'ün systemd'si `-BPF_FRAMEWORK` ile derlendiği için `SocketBindDeny` uygulanmaz: firewall 22, 80 ve 443 dışında her portu kapalı tutmalı (`host doctor` WARN verir).
- Snapshot'lar ve trash aynı diskte; off-site yedek yok (M3).

## 0.3.1

`v0.3.0` tag'i Linux CI'daki iki test hatası yüzünden yayınlanmadı; 0.3.1 aynı içeriği ve bu düzeltmeleri taşır (Linux'ta dinleme hatalarının sınıflandırılması, migration bellek testinin ölçümü).

M1 Faz A: tek sunucuda proje ve branch barındıracak host katmanının (Faz B) üzerine kurulacağı `serve` özellikleri. Tasarım: [docs/m1-mimari.md](docs/m1-mimari.md). Yeni davranışların çoğu bayrak ya da env ile açılır; bayraksız `serve`/`dev` aşağıda listelenenler dışında aynı çalışır.

### Yeni

- **Çıkış kodları.** `0` normal, `1` çökme, `64` config hatası, `65` migration reddi, `75` geçici (data dir kilitli, port meşgul), `78` uygulama tanım hatası. Tanım hataları (bozuk şema, bilinmeyen cron hedefi, tekrarlanan route) artık migration'dan **önce** yakalanır; veritabanına hiçbir şey yazılmaz.
- **JSON log.** `--log-format json` (ya da `INCIBASE_LOG_FORMAT`): her satır bir JSON nesnesi. İstek kimliği (`x-request-id`, `rid`) fonksiyonlara, job'lara ve abonelik yeniden çalıştırmalarına taşınır; kullanıcı kodundaki `console.*` çağrıları da JSON olur. Anahtar ve token'lar log'a yazılmaz.
- **Unix socket'ler ve admin yüzeyi ayrımı.** `--socket` public yüzeyi, `--admin-socket` dashboard'u ve admin API'sini ayrı socket'lerde sunar (`0770`). Admin yüzeyi yalnızca `localhost` Host'larını kabul eder, Origin kontrolü yapar ve CORS göndermez; public tarafta admin key `401` alır. Hosted modda `INCIBASE_ADMIN_KEY` ve `INCIBASE_STORAGE_SECRET` env'den zorunludur, meta'da secret varsa başlamaz.
- **Servis anahtarları.** `ik_svc_<id>_<secret>`, `INCIBASE_SERVICE_KEYS_FILE` ile; kapsamlar `internal`, `impersonate`, `upload`. Admin değildir; `SIGHUP` ile restart'sız yenilenir. Fonksiyonlarda `ctx.auth.service`. Public CORS için `INCIBASE_CORS_ORIGINS`.
- **Fonksiyon timeout'ları.** `--timeouts query=10s,mutation=10s,action=120s,http=120s`: süresi dolan çağrı geri alınır, kilidi bırakır, `504 FUNCTION_TIMEOUT` döner.
- **Drain.** `SIGTERM`/`SIGINT`'te yeni bağlantılar kesilir, WebSocket'ler `1012` ile kapanır, süren çağrılar ve job'lar `--drain-timeout` (varsayılan 10 s, dev 1 s) kadar beklenir. Yarıda kalan job'lar `interrupted` olur; `retryOnInterrupt` ile bir kez yeniden kuyruğa alınabilir. Kaçırılan cron'lar `cron_skipped` olarak loglanır.
- **Yüklemeler ve limitler.** Yüklemeler belleğe alınmadan diske stream edilir; eşzamanlı yükleme sayısı `INCIBASE_UPLOAD_CONCURRENCY` ile sınırlanabilir (varsayılan: sınırsız). `INCIBASE_MAX_UPLOAD_BYTES`, `INCIBASE_MAX_STORAGE_BYTES` (toplam kota), `INCIBASE_MAX_DB_BYTES` (`max_page_count`), S3 için `INCIBASE_S3_PREFIX`.
- **Release bundle'ları.** `incibase bundle` uygulamayı npm bağımlılıklarıyla birlikte tek bir `app.ib` dosyasına paketler (manifest + sha256); `serve --bundle app.ib` onu çalıştırır. Değiştirilmiş bundle, manifest'e gizlenmiş kod ve native addon reddedilir.
- **Preflight.** `serve --migrate-only` migration'ı çalıştırıp dinlemeden çıkar (`data.db` yoksa `64`; ilk release için `--allow-empty`). Migration da `INCIBASE_MAX_DB_BYTES` sınırına tabidir. Migration doğrulaması sayfalı yapılır; bellek kullanımı sınırlıdır.
- **Diğer.** Şifre hash'leme eşzamanlılığı `INCIBASE_AUTH_CONCURRENCY` ile sınırlanabilir (varsayılan: sınırsız; aşılırsa `503 AUTH_BUSY`). `/api/health` `generation`, `admin_overview` branch etiketi döner; dashboard'da branch etiketi ve prod şeridi.

### Davranışı değişenler (bayraksız kullanım dahil)

- Başlangıç hataları artık hep `1` değil, yukarıdaki kodlarla çıkar; bilinmeyen bayrak `64` verir.
- `SIGTERM` sunucuyu anında kapatmak yerine drain eder (en fazla 10 s).
- Restart sırasında yarıda kalan job'lar `failed` yerine `interrupted` olarak işaretlenir.
- Cron hedefi bir fonksiyon referansı olmalı; tekrarlanan HTTP route'ları ve var olan tekrarlara unique index tanım/migration hatasıdır.
- API yanıtları `x-request-id` başlığı taşır; `NO_COLOR` desteklenir.
- İstemci oturum token'ını `incibase:token:<baseUrl>` altında saklar (eski anahtar bir kez okunur), yeniden bağlanırken jitter kullanır ve `503` + `x-incibase-unprocessed: 1` yanıtlarını en fazla ~15 s tekrar dener.

## 0.2.0

Gerçek veriyle çalışmadan önce gereken güvenlik ve veri güvenliği düzeltmeleri.

### Davranışı değişenler

- **Migration artık veri silmiyor.** Değeri olan bir alanı kaldıran, yeniden adlandıran ya da iç içe bir anahtarı düşüren şema `MigrationError` ile reddedilir ve veritabanına dokunulmaz. Veriyi bilerek silmek için `--allow-field-removal` (`EngineOptions.allowFieldRemoval`).
- **Şema yoksa başlamaz.** Veritabanında aktif tablolar varken `schema.ts` yüklenmediyse sunucu başlamayı reddeder.
- **`where()` alan adlarını doğrular.** Alan adı ya da noktalı alan yolu olmayan bir anahtar `INVALID_FIELD` hatası verir.
- **`admin_sql` yalnızca tek bir okuma sorgusu çalıştırır** (SELECT, VALUES, WITH, EXPLAIN). `ATTACH`, `PRAGMA` ve birden fazla statement reddedilir; `_incibase_meta`, `_passwords` ve `_sessions` okunamaz. Sorgu ayrı bir process'te, 5 saniyelik süre sınırı ve 1000 satır tavanıyla çalışır.
- **İstek boyutları sınırlı.** JSON route'ları 1 MB (`INCIBASE_MAX_JSON_BYTES`), WebSocket mesajları 1 MB; soket başına abonelik sayısı ve toplam boyutu sınırlı. Yükleme sınırı gerçek akan bayt üzerinden uygulanır.
- **Bir data dir'i aynı anda yalnızca bir process açabilir.** İkinci sunucu açık bir hatayla durur. Data dir `0700`, dosyalar `0600` oluşturulur.

### Düzeltilenler

- Tek bir hatalı WebSocket mesajı (`null`, sayı olan token vb.) artık sunucuyu çökertmiyor.
- Scheduler'daki arka plan hataları ve yakalanmamış promise'ler sunucuyu düşürmüyor; hatalar loglanıp çalışmaya devam ediliyor. Uzun süren bir job diğer job'ları bekletmiyor.
- Şemadan kaldırılan tablolardaki ya da düz `id("_storage")` alanlarındaki dosyalar artık temizlikte silinmiyor; temizlik adayları silme transaction'ı içinde yeniden kontrol ediliyor.
- Üretimde (dev dışı) MCP ve HTTP hataları stack trace ya da iç mesaj sızdırmıyor.

### Yeni

- Admin araçları: `admin_delete_user`, `admin_set_user_disabled`, `admin_revoke_sessions`. Oturumu iptal edilen, devre dışı bırakılan ya da silinen kullanıcıların açık WebSocket bağlantıları anonim kimliğe düşürülür.

## 0.1.0

İlk yayın.
