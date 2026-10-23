# M1 Mimari: Projeler ve Branch'ler

Hedef sürüm incibase 0.3.0, tarih 2026-10-22. Durum: tasarım, sahibin onayını bekliyor.

Kanıt etiketleri:
- **[P]** probe ile doğrulandı.
- **[C]** koddan okundu.
- **[I]** çıkarım; sürümden önce Linux CI e2e ile doğrulanmalı.

> nginx davranışları (connect hatasının `upstream_connect_time="-"` ile ayırt edilmesi, `Set-Cookie Domain=` boşaltma, path blokları) tasarım sırasında gerçek bir nginx ile çalıştırılmadı. Bu yüzden [I] olarak işaretli ve adım 11'de test edilecek.

**Özet**
- Supervisor systemd.
- Her branch, opt-in bayraklarla çalışan bugünkü `incibase serve`. Kendi OS kullanıcısıyla, systemd sandbox'ında koşar.
- Ön kapı stok **nginx**.
- Kontrol düzlemi: SQLite registry üzerinde root-only bir CLI. Daemon yok.
- Her ayrıcalıklı işlem `src/host/ops.ts` içinde bir fonksiyon; M4 bunları HTTP'ye açar.
- Admin gücü yalnızca `admin.sock` üzerinden, SSH tüneliyle.

## Eleştirilerden gelen değişiklikler

1. **Servis anahtarı.** `ik_svc_` artık admin kimliği değil; `{admin:false, service:{keyId, scopes}}` olarak tanımlanır. Varsayılan kapsamı `internal`. İptal SIGHUP ile anında yapılır.
2. **Sırlar fail-closed.** Hosted modda env sırları zorunlu. Meta'da sır bulunursa exit 64.
3. **Proxy yerine nginx.** Restart boşluğunu istemci retry'ı kapatır. nginx bağlantının kurulamadığını `$upstream_connect_time="-"` ile ayırt eder [I].
4. **Yükleme stream edilir.** Kota ve semafor var. Eskiden iki adet 100 MiB yükleme 512M'lik branch'i OOM'a sokuyordu [P].
5. **Migration.** Sayfalı doğrulama. Production'da snapshot ve MemoryMax altında preflight. Commit sonrası kod otomatik geri alınmaz.
6. **Restart davranışı.** `RestartSteps` kaldırıldı; 120 s içinde en fazla 8 başlatma. 78 yalnızca incibase'in tespit ettiği tanım hatalarında.
7. **Watchdog Worker kaldırıldı.** Yerine `incibase-check.timer`: health, stall kill, alarm.
8. **Runtime branch başına pinlenir.** SHA256SUMS doğrulanır.
9. **SSH kopmasına dayanıklılık.** Provisioning iki fazlı. Release `systemd-run` transient unit'inde koşar.
10. **Daha sıkı sandbox.**
    - Loopback ve özel ağlar yasak.
    - `SocketBindDeny`.
    - tmpfs `/tmp`.
    - slice.
    - `chmod 0770`.
    - uid doğrulaması.
11. **Local driver ürün değil.** Host testleri gerçek systemd'de (OrbStack Ubuntu ve CI) koşar.
12. **Diğer.**
    - `auth.ts`'de argon2 semaforu.
    - Jitter.
    - `TZ`.
    - Generation gate.
    - Admin yüzeyinde CORS yok; Host ve Origin kontrolü var.
    - Root tenant byte'larını çalıştırmaz.

---

## 1. Hedefler ve hedef dışı

**Hedefler**
1. Tek VPS'te projeler ve branch'ler (`prod`, `dev`, `preview`). Her branch'in ayrı süreci, uid'si, verisi, anahtarları, release'i ve URL'si var (`https://<branch>--<project>.<domain>`).
2. Branch'ler arasında veri, sır, soket, süreç ve kaynak (bellek, PID, CPU, disk) izolasyonu. Branch içinde kodun kendisinden gizli hiçbir şey yok; bu sınır kabul edildi.
3. Public internette admin gücü yok.
4. Tek kişinin işletebileceği bir yapı: systemd, journald, nginx, SSH. Container yok.
5. Drain, backoff, kalıcı hatada döngüye girmeme, preflight ve health gate.
6. Arıza müşteriden önce sahibe alarm olarak düşer.
7. Yeni bayrak verilmedikçe tek uygulama `serve` değişmez.
8. M2-M5 için temiz dikişler.

**Hedef dışı:**
- Kontrol API'si, deploy anahtarları, konsol (M4).
- Planlı ve off-site yedekler (M3).
- ACME.
- Branch içi sandbox.
- Sıfır kesintili restart (DataDirLock).
- HA.

---

## 2. Kararlar

| Konu | Seçim | Gerekçe |
|---|---|---|
| Süreç modeli | Branch başına bir OS süreci | `globalThis[ID_TABLE_RESOLVER]` son yazanı kazandırır (engine.ts:155) [P]. ESM cache [P]. Senkron SQLite health'i 1,45 s bekletti [P]. Boştaki branch ≈27 MB PSS. |
| Ön kapı | nginx, statik `server` bloğu, `proxy_pass http://unix:$ib/http.sock:` | Host routing, XFF üzerine yazma, WS, `limit_req`, path blokları [I]. Reload bağlantıları düşürmez. Worker havuzu var. Proxy için ayrı bir L adımı gerekmez. |
| Restart boşluğu | `@ib_down` yalnızca `upstream_connect_time="-"` iken `503` döner, `x-incibase-unprocessed: 1` ile. İstemci 15 s boyunca jitter'la tekrar dener. | `-` (connect hatası) ile `0.000` (erken kapanma) ayrışıyor [I]. Mutation'ı tekrarlamak güvenli. |
| Kimlik | `ib-<id>`. uid `uid_next` sayacından (70000+) gelir, asla yeniden kullanılmaz. | uid'ler arası EACCES ve EPERM [P]. |
| Taşıma | `run/http/http.sock`: 2750, grup `incibase-proxy` (`www-data` bu grupta). `run/admin/admin.sock`: grup `incibase-admin`. İkisinde de açık `chmod 0770` ve `idleTimeout: 0`. | Loopback TCP'ye her uid bağlanabilir [P]. Bun soketi 0755 açıyor [P]. |
| Admin yüzeyi | `--admin-socket` ile ayrılır. `ik_admin_` public tarafta 401. | Admin anahtarı her rotada geçiyor: http.ts:141,204, auth.ts:201-212, mcp.ts:43. |
| Servis anahtarı | `ik_svc_<id>_<secret>`. Kapsamlar `internal` (varsayılan), `impersonate`, `upload`. `isAdmin` false. | `docs/baska-projede-kullanim.md:40` yalnızca internal çağrı istiyor. |
| Sırlar | Registry `env` tablosu → `control/env/<id>.env` (0600). | engine.ts:170-176 ve storage.ts:146-151 sırları sessizce meta'ya yazıyor [C]. |
| Release | Tek dosya `app.ib`: `/*! incibase-manifest {json} */` + ESM bundle. VPS'te derleme yok. | Root yalnızca manifest satırını Zod ile okur, asla `import()` etmez. Standalone binary paket kurmaz [P]. |
| Deploy kapısı | Registration `migrate()`'ten önce. Production'da sıra: snapshot → preflight → restart → gate. | Eski kod migrate edilmiş veriyi 65 ile reddeder [P]. |
| Drain | `server.stop()`, `closeAll(1012)`, ardından `--drain-timeout`. | `stop(true)` commit edilmiş istemcileri kesiyordu (cli.ts:193) [P]. |
| Canlılık | Timer her 30 s'de admin `/api/health` çağırır. 3 ardışık hatada SIGKILL. | Worker süreç başına 8,5 MB ve 3-4 thread tutuyordu [P]. |
| Limitler | `incibase.slice` (RAM − 1G), MemoryMax, MemoryHigh %90, `max_page_count`, depolama kotası. | argon2 hash başına ≈64 MiB [P]. |
| Loglar, timeout | `--log-format json`, tenant `console.*` → `{ev:"console",rid}`. Kooperatif deadline: query ve mutation 10 s, action ve http 120 s. | journald tek unit'te satır düşürüyor [I]. Askıda kalan mutation yazmaları kilitliyordu [P]. |

---

## 3. Mimari

```
Internet ─:443─▶ nginx (TLS, limit_req/limit_conn, JSON log)
                  │ $ib = /var/lib/incibase/hosts/<label> → branches/<id>/run/http
                  ▼
   http.sock ── incibase-branch@<id> (ib-<id>, incibase.slice, sandbox)
                /usr/local/lib/incibase/<ver>/incibase serve --bundle releases/<seq>/app.ib --socket … --admin-socket …
   admin.sock ◀── ssh -N -L 127.0.0.1:7101:/var/lib/incibase/admin/prod--shop.sock
   incibase-check.timer → health, stall kill, alarm      sudo incibase … → ops.ts → registry + systemctl
```

### 3.1 Bileşenler

| Bileşen | Değişiklik |
|---|---|
| `src/cli.ts`, `exit-codes.ts` | Yeni bayraklar: `--socket`, `--admin-socket`, `--bundle`, `--log-format`, `--drain-timeout`, `--timeouts`, `--migrate-only`. Çıkış kodları:<br>• 0<br>• 1: çökme veya kullanıcı modülü hatası, restart edilir<br>• 64: config, eksik sır, meta'da sır, bind EACCES, DB şeması binary'den yeni<br>• 65: migration reddi<br>• 75: LOCK veya EADDRINUSE<br>• 78: incibase'in tespit ettiği tanım hatası |
| `http.ts` | LOCK alındıktan sonra stale unlink, ardından `chmod 0770`. Public yüzeyde admin rotaları, `/api/schema`, `/_` ve admin MCP yok. Admin yüzeyinin her rotasında (`/api/ws` http.ts:261 ve `/mcp` http.ts:272 dahil) Host localhost/127.0.0.1/[::1] olmalı ve Origin Host ile eşleşmeli. Admin'de CORS yok; public'te `INCIBASE_CORS_ORIGINS`. WS ayarı: `idleTimeout: 60, sendPings: true` [I]. |
| `auth.ts`, `engine.ts:232,307` | `allowInternal = admin ‖ scopes∋internal`. `x-incibase-as-user` yalnızca admin veya `impersonate` ile. `ctx.auth.service` eklenir. `INCIBASE_SERVICE_KEYS_FILE` SIGHUP geldiğinde yeniden okunur. SIGHUP handler'ı `serve`'ün ilk satırında kurulur; aksi halde erken gelen bir reload süreci öldürür ve systemd bunu temiz çıkış sayar. argon2 semaforu `INCIBASE_AUTH_CONCURRENCY` = ⌊(MemoryMax−128M)/64M⌋, 1 ile 4 arasında; `admin_create_user` da dahil. |
| `engine.ts:131-144`, `migrate.ts:222`, `scheduler.ts:58-67` | Registration ve `validateCrons()` `migrate()`'ten önce. `drain()`, deadline'lar, `{ev:"migration_committed"}`. Health `INCIBASE_GENERATION` döner. Doğrulama aynı transaction'da `WHERE _id > ? LIMIT 5000` sayfalarıyla. `system_schema_version`. Yarıda kalan işler `interrupted` olur (opt-in `retryOnInterrupt`). Atlanan cron'lar `cron_skipped` olarak loglanır. |
| `storage.ts` | `INCIBASE_STORAGE_SECRET`, `INCIBASE_S3_PREFIX`. `.tmp-<id>` dosyasına stream, artımlı sha256. Bugün dosya üç kez kopyalanıyor: http.ts:212, storage.ts:218,229. Semafor 2. Kota için meta'da `storage_bytes`. |
| `bundle.ts`, `loader.ts` | Manifest: sha256, sürüm, `describeApp`, `envNames`. Birden fazla çıktı veya `.node` varsa hata. `--check`. |
| `src/client.ts` | `incibase:token:<baseUrl>`, full jitter (client.ts:266-267), unprocessed retry. |
| `src/host/*` | `registry`, `names`, `ops`, `driver` (testler için sahte driver), `systemd`, `render`, `nginx`, `release`, `snapshot`, `check`, `doctor`, `tunnel`, `cli`. |

### 3.2 Akışlar

**A. HTTP**
1. nginx TLS'i sonlandırır. `$ib` dizini yoksa 404.
2. `limit_req` uygulanır. İstemcinin gönderdiği `X-Forwarded-*`, `Forwarded`, `X-Real-IP` başlıkları silinir; yerine `$remote_addr` ve `$request_id` yazılır.
3. İstek unix soket üzerinden keepalive olmadan iletilir.
4. Branch bearer'ı çözer. `engine.call` deadline ile yarışır; aşılırsa ROLLBACK ve 504.
5. Yanıttaki `Set-Cookie Domain=` boşaltılır [I]. RFC 6265 §5.2.3'e göre boş Domain yok sayılır [I].
6. Restart sırasında 503-unprocessed döner, istemci tekrar dener.

**B. WebSocket.** nginx bağlantıyı tüneller. Sınırlar: IP başına 200, branch başına 5000, `proxy_read_timeout 130s`. Restart'ta istemciye 1012 ulaşır; istemci jitter'la yeniden bağlanıp yeniden abone olur (client.ts:248).

**C. Dashboard**
1. Sunucuda bir kez: `sudo incibase host add-admin omer`.
2. Laptopta `incibase tunnel shop/prod --ssh omer@vps --open`. Komut `admin/index.json`'u okur, `ssh -N -L 127.0.0.1:7101:…/prod--shop.sock` açar ve `/_/` sayfasını açar. Bunun için sshd'de `AllowStreamLocalForwarding yes` olmalı; `host doctor` ayrıca `DisableForwarding` ayarını kontrol eder [I].
3. Admin anahtarı `sudo incibase admin-key shop/prod` ile alınır.
4. Her branch'in kendi portu, dolayısıyla kendi origin'i ve localStorage slotu var. MCP aynı tünelde `/mcp`'de.

**D. Branch ve release**
1. `createBranch` iki fazlıdır.
   - Faz 1: kısa bir transaction'da `uid_next++`, `phase='provisioning'`, sistem env satırları ve audit **commit** edilir.
   - Faz 2 (idempotent):
     1. `getpwuid` boş olmalı.
     2. `groupadd --system --gid <uid> ib-<id>`, ardından `useradd --system --uid <uid> --gid <uid> --home-dir /nonexistent --shell /usr/sbin/nologin ib-<id>`. gid verilmezse useradd sistem aralığından (989 gibi) yeniden kullanılabilecek bir gid ve `/home/ib-<id>` seçiyor [P]; `userdel` grubu da siler [P].
     3. `getpwnam` eşleşmeli.
     4. `find /var/lib/incibase -uid` boş dönmeli.
     5. Ağaç, env dosyası, drop-in, `daemon-reload`, symlink'ler ve `phase='ready'`.
   - Yarım kalan işi `host render` tamamlar ya da geri alır.
2. Deploy: `incibase bundle --out app.ib`, `scp app.ib vps:`, ardından `ssh -t vps sudo incibase release add shop/prod ~/app.ib`. Root manifest'i doğrular ve sha256 hesaplar. Release `releases/<seq>/app.ib` yoluna (root:ib-<id> 0640) `staged` olarak yazılır.
3. Gerisi `systemd-run --unit=incibase-release-<id>-<seq> --collect` içinde koşar; CLI journal'ı izler.
   1. **Snapshot:** root, `mode=ro` ile `VACUUM INTO backups/<id>/pre-<seq>.db` çalıştırır (LOCK tutulurken çalıştığı doğrulandı [P]), ardından 0600. 2×DB + 100 MB boş alan yoksa iptal.
   2. **Preflight:** kopya üzerinde `incibase-preflight@<id>` aynı sandbox ve MemoryMax ile `serve --migrate-only` çalıştırır. 64, 65, 78 veya OOM gelirse canlı branch'e dokunulmaz. Süre gate timeout'unu belirler. Kopyada `data.db` yoksa 64 döner; henüz verisi olmayan yeni bir branch'in ilk release'i `--allow-empty` ile geçer.
   3. Drop-in'e `--bundle` ve `INCIBASE_GENERATION=<seq>.<nonce>` yazılır, restart edilir. Gate generation birebir eşleşene kadar bekler.
   4. Başarılıysa `live`, son 5 release tutulur.
   5. Başarısızsa ve `migration_committed` yoksa önceki release'e dönülür. Commit varsa release kalır, alarm gider ve `release rollback --restore pre-<seq>` önerilir; snapshot sonrası yazılanlar kaybolur.

**E. Restart**
1. SIGTERM: `server.stop()` (yeni istekler 503-unprocessed alır), `scheduler.stop()`, `closeAll(1012)`.
2. `drain(10s)`. Süre dolarsa deadline'lar ve `stop(true)`.
3. LOCK bırakılır, exit 0. `TimeoutStopSec` = drain + 15 s.

---

## 4. İzolasyon modeli

### 4.1 Linux

| Tehdit | Koruma | Durum |
|---|---|---|
| A → B'nin `data.db` ve `storage/`'ı | Ayrı uid, 0700/0600, uid'nin daha önce kullanılmadığı doğrulanır | [P] |
| A → B'nin env, argv ve süreçleri | environ sahibe özel; ProtectProc=invisible; argv'de sır yok | environ [P], ProtectProc [I] |
| A → B'nin soketleri | 2750 dizin, `chmod 0770` | [P] |
| A → host-local servisler ve metadata | `IPAddressDeny=localhost 10/8 172.16/12 192.168/16 100.64/10 169.254/16 fc00::/7 fe80::/10`, `IPAddressAllow=127.0.0.53` | [I] |
| A'nın TCP listener açması | `SocketBindDeny=any` | [I] |
| A → bellek, CPU, PID, disk | slice, MemoryMax/High, CPUQuota, TasksMax, `max_page_count`, kota, ballast | OOM [P] |
| `.env` / `bunfig.toml` ile kalıcılık | Root'a ait cwd; ProtectSystem=strict | autoload [P] |
| Kötü niyetli release → root | Root yalnızca JSON okur; preflight branch uid'siyle sandbox'ta | test |
| İnternet → admin | Yalnızca admin.sock; `ik_admin_` 401; path blokları | test |
| Sızan servis anahtarı | Tek branch, `internal`; impersonation yok; SIGHUP ile iptal | test |
| Ön kapı DoS | nginx worker'ları, `limit_conn`, `OOMScoreAdjust=-900`, `MemoryMin=64M` | [I] |

**Korunmayanlar**
- Branch içi sırlar (loader.ts:84).
- **S3 prefix bir sınır değil.** Tenant, env'deki anahtarla kendi `S3Client`'ını kurabilir. Sınır kimlik bilgisidir: prefix'e kapsamlı IAM ya da branch başına bucket. Başka bir branch'in `S3_ACCESS_KEY_ID`'si `--shared-s3-credentials` verilmeden reddedilir.
- İnternete egress.
- Kernel LPE.
- nginx'in bearer'ları görmesi.
- Düz metin `registry.db` (M3).
- httpAction'larda ambient cookie auth: dokümanda yasaklanır.

### 4.2 macOS ve testler

- `incibase dev` değişmez.
- Serve düzeyindeki özellikler (soket, yüzey, drain, timeout, bundle) macOS'ta `bun test` ile, doğrudan spawn edilerek test edilir.
- Host katmanı Linux'ta test edilir: `orb create ubuntu:noble incibase-e2e` ve CI `ubuntu-24.04`.

---

## 5. Kontrol düzlemi

### 5.1 Registry

```sql
-- control/registry.db  root 0600, WAL, user_version=1. Yalnız istenen durum; gerçeği `systemctl show` verir.
-- Uygulamada (adım 9): kind IN ('prod','dev','preview'); os_uid < 100000 (Ubuntu SUB_UID_MIN); branches'ta
-- created_at/updated_at, releases ve service_keys'te created_at; settings'te uid_base.
-- Adım 10: branches.generation (drop-in'deki INCIBASE_GENERATION); releases'ta bytes, preflight,
-- allow_field_removal, generation, preflight_ms, finished_at, pruned_at (dosyası silinen release'in satırı kalır);
-- alerts.message; settings'te layout (unit öneki, gruplar, runtime ve systemd dizinleri) ve slice_memory_max.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- domain, timezone, trust_proxy, alert_webhook, cli_version, uid_next (70000+), tunnel_port_next
CREATE TABLE projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE branches (
  id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(slug), name TEXT NOT NULL,
  kind TEXT NOT NULL, protected INTEGER NOT NULL, label TEXT NOT NULL,   -- '<name>--<project>' <=63
  os_uid INTEGER NOT NULL UNIQUE CHECK (os_uid >= 70000), tunnel_port INTEGER NOT NULL UNIQUE,
  phase TEXT NOT NULL,              -- provisioning|ready|deleting|deleted
  desired_state TEXT NOT NULL, release_seq INTEGER, runtime_version TEXT NOT NULL, busy_unit TEXT,
  s3_prefix TEXT NOT NULL UNIQUE, limits_json TEXT NOT NULL, config_json TEXT NOT NULL,
  copied_from_branch_id TEXT REFERENCES branches(id));   -- M2
CREATE UNIQUE INDEX branches_live_label ON branches(label) WHERE phase <> 'deleted';
CREATE TABLE releases (branch_id TEXT NOT NULL, seq INTEGER NOT NULL, sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL, status TEXT NOT NULL,   -- staged|preflight|live|failed|superseded|interrupted
  snapshot TEXT, migration_committed INTEGER, exit_code INTEGER, error TEXT, origin TEXT NOT NULL,
  PRIMARY KEY (branch_id, seq));
CREATE TABLE env (branch_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (branch_id, name));
CREATE TABLE service_keys (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'internal', label TEXT NOT NULL, revoked_at INTEGER);
CREATE TABLE alerts (key TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL, notified_at INTEGER);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER, actor TEXT, action TEXT, branch_id TEXT, detail_json TEXT, ok INTEGER);
```

### 5.2 Owner API (`ops.ts`)

- Her op:
  - Zod ile doğrular.
  - `control/LOCK`'u yalnızca kısa transaction'larda tutar.
  - Audit yazar.
  - Türetilmiş dosyaları commit'ten **sonra** atomik olarak render eder.
- Uzun op'lar `busy_unit` ayarlar; branch meşgulken başka op reddedilir.
- Op'lar: `createProject`, `createBranch`, `setBranch`, `start`, `stop`, `restart`, `deleteBranch`, `addRelease`, `rollback({to, restore})`, `upgradeBranch`, `env*`, `adminKey`, `serviceKey*`, `status`, `logs`, `render`, `check`, `installRuntime`.
- M4 bunları aynı imzalarla `/control/v1/…` altında sunar.

### 5.3 Auth

| Kimlik bilgisi | Geçerli olduğu yer | İptal |
|---|---|---|
| root (sudo) | tüm op'lar | — |
| `incibase-admin` grubu | SSH tüneli ve admin soketleri | gruptan çıkarma |
| `ik_admin_…` | hosted: yalnızca admin.sock; tek uygulama: 0.2.0'daki gibi | `--rotate` + restart |
| `ik_svc_<id>_…` | tek branch'in public listener'ı, kapsamlar dahilinde | `revoke` + `systemctl reload` |

### 5.4 Türetilmiş dosyalar

**`incibase-branch@.service`**, taslağın sertleştirme setine göre şu satırlarla değişir:
- **Kalanlar:** ProtectSystem=strict ve ReadWritePaths; InaccessiblePaths; ProtectHome, PrivateDevices, ProtectProc, NoNewPrivileges; boş CapabilityBoundingSet; RestrictNamespaces; `UMask=0007`.
- **Kaldırılanlar:** `PrivateTmp`, `BUN_OPTIONS`.

```ini
[Unit]
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/var/lib/incibase
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Slice=incibase.slice
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=64 65 78
# serve kendi SIGHUP handler'ını kurmadan önce (runtime ve import'lar, ~40 ms) gelen bir reload süreci sinyalle bitirir;
# systemd bunu temiz çıkış sayıp restart etmezdi.
RestartForceExitStatus=SIGHUP
ExecReload=/bin/kill -HUP $MAINPID
TemporaryFileSystem=/tmp:size=64M
SocketBindDeny=any
IPAddressDeny=localhost 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10
IPAddressAllow=127.0.0.53/32
```

**Branch başına dosyalar**
- **Drop-in**
  - `ExecStart=/usr/local/lib/incibase/<runtime_version>/incibase serve --bundle …/releases/<seq>/app.ib …`
  - `MemoryMax=512M`, `MemoryHigh=460M`, `MemorySwapMax=0`, `CPUQuota`, `TasksMax`, `TimeoutStopSec=25`.
- **`incibase-preflight@.service`**: aynı sandbox ve `RestartForceExitStatus=SIGHUP`; yalnızca `…/%i/preflight` yazılabilir.
- **Env dosyası** (0600):
  - `INCIBASE_ADMIN_KEY`, `INCIBASE_STORAGE_SECRET`.
  - `INCIBASE_SERVICE_KEYS_FILE`: `branches/<id>/service-keys.json` dosyasını gösterir (root:ib-<id> 0640; yalnızca sha256 ve kapsamlar).
  - `INCIBASE_GENERATION`, `INCIBASE_BRANCH_LABEL`/`KIND`, `TZ`.
  - `INCIBASE_MAX_{DB,STORAGE,UPLOAD}_BYTES`, `INCIBASE_AUTH_CONCURRENCY`.
  - `INCIBASE_S3_PREFIX`, `S3_*` ve uygulama env'leri.

**Adım 10'da doğrulanan sapmalar** (OrbStack Ubuntu 24.04, systemd 255):
- `TemporaryFileSystem=/tmp:size=64M,mode=1777` [P]. Seçeneksiz tmpfs root 0755 bağlanıyor; branch kullanıcısı `/tmp`'ye yazamıyordu.
- `incibase-preflight@.service` `Type=exec`, oneshot değil [P]: systemd `Type=oneshot` ile `RestartForceExitStatus=` kabul etmiyor ("isn't allowed for Type=oneshot services. Refusing"). Job, unit bitene kadar `systemctl show`'u yoklar; asılı kalan preflight'ı `RuntimeMaxSec=900` durdurur. Başarılı bir `Type=exec` unit'i bittikten sonra `ExecMainCode=0` gösterir, 1 değil [P].
- `INCIBASE_GENERATION` env dosyasında değil, drop-in'de `Environment=` olarak durur; env dosyası release'ler arasında değişmez.
- Unit adları bir önekten gelir (varsayılan `incibase`): test host'ları `incibase-s10-branch@<id>.service` gibi kendi adlarını kullanır. `incibase-s10.slice` systemd'nin ad hiyerarşisi yüzünden `incibase.slice`'ın altına düşer.
- Gate, generation'ı en az 1 s arayla iki kez ve arada restart olmadan görmeden geçmez: hazır olup hemen çöken bir release'i yakalar. `migration_committed`, restart'tan önce alınan journal cursor'ından sonraki ve sürecin kendisinin yazdığı (`_SYSTEMD_INVOCATION_ID` olan) satırlarda, en üst düzeyde `ev` olarak aranır; uygulamanın `console` çıktısı sayılmaz. `journalctl -o json` 4096 byte'tan uzun alanları `--all` olmadan `null` basıyor [P].
- Çöken release: `Restart=on-failure` ile 8 restart, ≈19 s içinde `failed` (`NRestarts=8`) [P]; migration commit edilmediği için önceki release'e dönülür.
- `env set` satır sonu ve sekme dışındaki kontrol karakterlerini reddeder. systemd tırnak içindeki satır sonunu değerin parçası sayıyor [P], ama dosyada kendi başına değişken gibi okunan bir satır oluşurdu; çok satırlı değerler base64 ile verilir.
- Onay kelimesi branch'in hostname'idir (`prod--shop.<domain>`). Silme, korunmasa da her production branch'inde onay ister.
- Release olmadan drop-in'de `ExecStart` yok; unit `bad-setting` görünür ve başlamaz [P]. `systemctl reset-failed` yüklenmemiş bir instance için 1 ile çıkar, `stop` 5 ile [P].
- OrbStack container'ında `/run/systemd/system/service.d/zzz-lxc-service.conf` her servis için ProtectSystem, ProtectHome, PrivateDevices, NoNewPrivileges, ReadWritePaths ve ProtectProc'u kapatıyor; SocketBindDeny etkisiz. Etkili olanlar: IPAddressDeny (127.0.0.1 ve 169.254.169.254 zaman aşımı), TemporaryFileSystem, InaccessiblePaths, boş CapabilityBoundingSet [P]. `test/host-systemd.test.ts` hangi direktifin etkisiz olduğunu ve onu neyin kapattığını raporlar; adım 15'teki gerçek VM'de `INCIBASE_TEST_REQUIRE_SANDBOX=1` ile hepsi zorunludur.

**`/etc/nginx/conf.d/incibase.conf`** (branch başına satır içermez):
```nginx
map $http_upgrade $ib_conn { default upgrade; "" close; }
limit_req_zone  $binary_remote_addr zone=ib_ip:20m rate=50r/s;
limit_req_zone  $binary_remote_addr zone=ib_auth:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=ib_ipc:10m;
limit_conn_zone $ib_label zone=ib_br:10m;
server {
  listen 443 ssl; http2 on;
  server_name ~^(?<ib_label>[a-z0-9-]+--[a-z0-9-]+)\.apps\.example\.net$;
  set $ib /var/lib/incibase/hosts/$ib_label;
  if (!-d $ib) { return 404; }
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $ib_conn;
  proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header x-request-id $request_id;
  proxy_set_header Forwarded ""; proxy_set_header X-Real-IP "";
  proxy_cookie_domain ~.+ "";
  proxy_read_timeout 135s; client_max_body_size 2m;
  limit_req zone=ib_ip burst=100 nodelay; limit_req_status 429;
  error_page 502 = @ib_down;
  location ~ ^/(_|api/admin|api/schema)(/|$) { return 404; }
  location ~ ^/api/auth/(signin|signup|password) { limit_req zone=ib_auth burst=5 nodelay; proxy_pass http://unix:$ib/http.sock:; }
  location = /api/ws { limit_conn ib_ipc 200; limit_conn ib_br 5000; proxy_read_timeout 130s; proxy_pass http://unix:$ib/http.sock:; }
  location = /api/storage/upload { client_max_body_size 101m; proxy_request_buffering off; proxy_pass http://unix:$ib/http.sock:; }
  location / { proxy_pass http://unix:$ib/http.sock:; }
  location @ib_down {
    if ($upstream_connect_time != "-") { return 502; }
    add_header Access-Control-Allow-Origin * always; add_header Access-Control-Expose-Headers x-incibase-unprocessed always;
    add_header Access-Control-Allow-Headers "authorization, content-type, x-incibase-as-user" always;
    add_header Retry-After 1 always; add_header x-incibase-unprocessed 1 always;
    if ($request_method = OPTIONS) { return 204; }
    default_type application/json; return 503 '{"error":{"code":"BRANCH_UNAVAILABLE"}}';
  }
}
```

`@ib_down` CORS başlıklarını kendisi ekler ve OPTIONS'a 204 döner. Bu olmasa tarayıcı, restart sırasında preflight'ı başarısız sayar ve istemci yalnızca bir `TypeError` görür; 503'ü hiç okuyamaz [I, CI'da test edilecek].

Ayrıca render edilenler:
- Sertifika.
- Bilinmeyen SNI için `ssl_reject_handshake`.
- `$uri` ile JSON log.
- Cloudflare için `real_ip_header`.
- Alias `server` blokları.
- nginx için `OOMScoreAdjust=-900` drop-in'i.

---

## 6. Dizin düzeni

```
/usr/local/lib/incibase/<ver>/incibase    root 0755 (SHA256SUMS);  /usr/local/bin/incibase -> cli sürümü
/var/lib/incibase/                        root 0755;  ballast (1 GiB)
  control/   root 0700                    registry.db*, LOCK, env/<id>.env 0600
  admin/     root:incibase-admin 0750     index.json, <label>.sock -> branches/<id>/run/admin/admin.sock
  hosts/     root:incibase-proxy 0750     <label> -> branches/<id>/run/http
  branches/  root 0711
    <id>/    root 0711                    cwd; service-keys.json
      data/       ib-<id> 0700            LOCK, data.db*, storage/
      releases/<seq>/app.ib               root:ib-<id> 0640 (son 5)
      preflight/  ib-<id> 0700            geçici
      run/http/   ib-<id>:incibase-proxy 2750;  run/admin/  ib-<id>:incibase-admin 2750
  backups/<id>/pre-<seq>.db  root 0600    (production, son 3)
  trash/     root 0700                    yalnızca production silmeleri, 7 gün
```

---

## 7. CLI

```
incibase bundle [--dir incibase] [--out app.ib] [--check]
incibase host init --domain apps.example.net --timezone Europe/Istanbul [--tls-cert … --tls-key …]
     [--trust-proxy cloudflare] [--firewall]   # systemd>=252, cgroup v2, `systemd-detect-virt -c`=none;
                                               # slice, journald Storage=persistent, needrestart istisnası, timer
incibase host add-admin|render|status|doctor|check|gc|install-runtime
incibase project create <slug> [--branches prod,dev] | list | delete
incibase branch create|list|info|set|start|stop|restart|delete|upgrade <p>/<b>   # protected: --confirm <hostname>
incibase release add <p>/<b> <app.ib|-> [--allow-field-removal] [--no-preflight] | list | rollback [--to] [--restore]
incibase env list|set|unset|import <p>/<b>
incibase admin-key <p>/<b> [--rotate] ; service-key create <p>/<b> --label x [--scopes …] | list | revoke
incibase status ; logs <p>/<b> [-f] [--errors] ; tunnel <p>/<b> --ssh user@vps [--open]
```

`set` ve `env` yalnızca `--restart` verildiğinde restart eder; böylece değişiklikler tek restart'ta toplanır. `env import`, `manifest.envNames`'te olup eksik kalanlar için uyarır.

---

## 8. Dashboard

Değişmeden admin.sock'ta çalışır, çünkü yalnızca root-relative çağrılar yapar (api.ts:42,60). Küçük eklemeler:
- `admin_overview` `branch {label, kind}` ve `surface` döner.
- `layout.tsx:107` `shop/prod` gösterir; production'da kırmızı şerit çıkar.
- `overview.tsx:37` MCP komutunu `location.origin` ile oluşturur.

---

## 9. Hata yönetimi

| Hata | Davranış |
|---|---|
| Event loop takılması | Üç başarısız probe'dan (her biri 30 s arayla) sonra SIGKILL, restart ve alarm. Migration sırasında soket henüz yok; öldürmek yerine "başlangıç uzun sürüyor" alarmı. |
| Çökme veya OOM | 2 s sonra restart. 120 s içinde 8 denemeyi aşarsa `failed` ve alarm. Çıkış 1 veya 137 ise 10 dakika sonra bir kez `reset-failed` ile yeniden deneme. |
| 64 / 65 / 78 | Retry yok. Preflight bunları canlıdan önce yakalar. |
| Commit sonrası sağlıksız | Release yerinde kalır, alarm, `--restore` önerisi. |
| Disk | Branch başına `SQLITE_FULL` veya kota. %80 ve %90'da alarm. Ballast. |
| SSH kopması | Transient unit sürer. `host render` provisioning'i onarır. |
| Restart boşluğu | 503-unprocessed ve istemci retry. Diğer istemciler `Retry-After: 1` görür. |
| needrestart | Branch'ler istisnada. `branch restart --all` sırayla ve gate'li çalışır. |
| Container VPS, downgrade | `init` reddeder. Şeması binary'den yeni olan DB'de exit 64. |

**Adım 13'te doğrulanan sapmalar** (`src/host/check.ts`, `alerts.ts`, `doctor.ts`; OrbStack Ubuntu 24.04, systemd 255):
- Probe üç sonuç verir. Admin soketinde kimse dinlemiyorsa (dosya yok, ya da önceki sürecin bıraktığı dosya: ECONNREFUSED) branch "başlıyor" sayılır. serve soketi migration'dan sonra bağladığı için uzun migration da buraya düşer. Dinleyip 5 s içinde cevap vermeyen ya da 200 dışı dönen probe "hata" sayılır. Sokete konmuş symlink'e bağlanılmaz.
- Öldürme, aynı systemd invocation'ında üç ardışık hatadan sonra `systemctl kill --kill-whom=main --signal=SIGKILL` ile yapılır. SIGSTOP ile durdurulan süreç üçüncü çalıştırmada öldürüldü ve systemd yeniden başlattı (`NRestarts` arttı) [P].
- "Başlangıç uzun sürüyor" alarmı 120 s sonra açılır; süreç öldürülmez.
- `failed` unit'te yeniden deneme şartı: exit 1, exit 137 ya da SIGKILL (OOM dahil). Arıza bölümü başına bir kez yapılır, 10 dakika sonra. Bölüm, branch yeniden sağlıklı görülünce biter. 64, 65 ve 78 yeniden denenmez. `inactive` olup çalışması gereken unit için de alarm açılır.
- Sayaçlar registry'de değil, `control/check-state.json` (root 0600) dosyasında tutulur; registry şeması değişmedi. Bozuk dosyayla sıfırdan başlanır.
- Alarm anahtarları: `health:<id>`, `startup:<id>`, `unit:<id>`, `disk:80`, `disk:90`.
- `alerts.state` yeni bir değer alır: `closed`. Akış `firing` → `resolved` → `closed` şeklindedir. Açılış bildirimi `notified_at`'ı yazar, kapanış bildirimi satırı `closed` yapar. Açılışı hiç gönderilmemiş bir alarm sessizce kapanır.
- Teslimat ilk hatada durur; kalanlar bir sonraki çalıştırmada gönderilir. Her POST için 10 s süre var ve yönlendirme izlenmez.
- Mesajdan şunlar çıkarılır: `ik_admin_`/`ik_svc_` biçimli anahtarlar, her app env değeri (≥ 8 karakter), host'un `*KEY*`/`*SECRET*` env değerleri ve webhook URL'sinin kendisi. Audit satırında URL değil yalnızca host tutulur.
- `host set alert_webhook` yalnızca https kabul eder. Kullanıcı, parola ve `#` içeren URL'ler reddedilir. `--test` ile bir deneme bildirimi gönderilebilir.
- Timer ayarları: `OnBootSec=60s`, `OnActiveSec=10s`, `OnUnitActiveSec=30s`. Servis `Type=oneshot` olduğu için iki check aynı anda koşmaz.
- Timer açılış anında hemen tetiklenir, çünkü `OnBootSec` geçmiştir [P]. Biten oneshot `ExecMainCode=0` gösterir ve `InvocationID` boştur [P].
- `host init`'te `checkTimer: false` verilirse `check_timer=off` olur: timer durur ve boot linki kalkar. Linux testleri bunu kullanır.
- Doctor'ın sandbox probe'u şöyle çalışır: `systemd-run --wait --pipe` ile `User=nobody` altında bir transient unit açılır. Bu unit, kurulu runtime binary'sini `BUN_BE_BUN=1` ile bun gibi çalıştırır [P, Bun 1.4.3]. Betik `/run` altında, deneme dosyası `/var/tmp` altında durur; ikisi de silinir.
- OrbStack sonuçları [P]:
  - SocketBindDeny, ProtectProc ve ProtectSystem etkisiz. `zzz-lxc-service.conf` ProtectSystem=no ve ProtectProc=default yazıyor.
  - IPAddressDeny etkili.
  - Container'da etkisiz direktif WARN olarak raporlanır, VM'de FAIL.
- Doctor'ın disk eşikleri: %90 kullanımda WARN, %95'te FAIL. systemd için alt sınır 252.

---

## 10. Tek uygulama `incibase serve` ile uyumluluk

**Varsayılanlar aynı:** TCP 3210, birleşik yüzey, anahtar meta'da, `/_/`, timeout yok.

**Herkese ulaşan düzeltmeler:**
- drain (dev'de 1 s)
- çıkış kodları
- `migrate()` öncesi registration
- token namespace (eski anahtar bir kez okunur)
- jitter ve unprocessed retry
- streaming yükleme
- sayfalı migration
- `interrupted`
- `NO_COLOR`

**`host adopt`:**
- Eski sunucu durmuş olmalı; LOCK bunu zorlar.
- Meta'daki `admin_key` ve `storage_secret` registry'ye taşınır ve meta'dan **silinir**. Eski imzalı URL'ler doğrulanmaya devam eder.
- `--keep-service-access`, eski anahtarı `internal,impersonate` kapsamlı servis anahtarı yapar. `isAdmin` kontrol eden httpAction'lar `ctx.auth.service`'e geçmeli.

---

## 11. Uygulama planı

S ≤ 1 gün, M 2-3 gün, L 4-5 gün. Toplam yaklaşık 34 gün (≈7 hafta). Adım 1-8, 0.3.0-alpha olarak ayrı yayınlanabilir.

| # | Adım | Ana test | Boyut |
|---|---|---|---|
| 1 | Çıkış kodları, `migrate()` öncesi registration | Bozuk şema 78 ve tablo yok; modül hatası 1 | S |
| 2 | JSON logger, console sarma | Her satır JSON; log'da anahtar yok | S |
| 3 | Soketler, yüzey ayrımı, servis anahtarları, SIGHUP, fail-closed, Host/Origin | `ik_admin_` 401; servis anahtarıyla impersonation yok; 64; soket 0770 | M |
| 4 | Drain, `interrupted`, cron kaydı | SIGTERM sırasındaki mutation 200; 1012 | M |
| 5 | Timeout'lar | 504 sonrası sıradaki mutation başarılı | M |
| 6 | Depolama: stream, kota, semafor, prefix | 512M'de 4 × 100 MiB yükleme | M |
| 7 | Sayfalı migration, `--migrate-only`, auth semaforu, istemci, dashboard | 200k doküman 192M'de; 300 istemci 15 s içinde | M |
| 8 | `app.ib` | npm bağımlılığı inline; `.node` reddi; standalone binary | M |
| 9 | Registry, iki fazlı provisioning | Faz 2'de kill sonrası `render` onarır | S |
| 10 | ops.ts, systemd driver, release pipeline | Commit öncesi revert; commit sonrası kalır ve alarm; SSH kopması | L |
| 11 | nginx renderer, `hosts/`, TLS reçeteleri | 404, 503-unprocessed ve 502 ayrımı; Domain boşaltma | S |
| 12 | Host CLI, tunnel | `/_/` ve `/mcp` | M |
| 13 | Check timer, alarm, doctor | Takılma 90 s içinde öldürülür; alarm tekilleştirme | M |
| 14 | Runtime pinleme, SHA256SUMS | Yanlış checksum reddi | S |
| 15 | Linux e2e CI | EACCES; ProtectProc; 127.0.0.1 ve 169.254 kapalı, DNS açık; `SocketBindDeny`; EnvironmentFile ile InaccessiblePaths; crash loop 30 s'de `failed` | L |
| 16 | `host adopt` (kesilebilir) | Meta'da sır yok | S |
| 17 | `docs/host.md`, CHANGELOG | Temiz VPS'te kurulum | S |

Zaman yetmezse önce şunlar kesilir: adopt, alias'lar ve Cloudflare `real_ip` (onun yerine cloudflared ile çalışan reçete C).

---

## 12. M2-M5 dikişleri

- **M2:**
  - `snapshot.ts` ve `--restore` hazır.
  - Eklenecekler: `backups` tablosu ve kopya akışı. Kopya akışı snapshot ve restore'dan sonra scrub yapar: `_sessions` boşaltılır, `_scheduled` iptal edilir, `_passwords` politikası uygulanır.
  - S3'te kopya prefix'ten prefix'e yapılır.
  - Kopya branch, kaynağın servis anahtarlarını ve env'ini **devralmaz**.
  - Preflight, dry-run'a dönüşür.
- **M3:**
  - `incibase-backup.timer`, check timer ile aynı kalıpta.
  - Off-site için host kimlik bilgileri kullanılır.
  - Registry yedekleri şifrelenir.
- **M4:**
  - `incibase-control.service`, `ops.ts`'i unix sokete açar.
  - nginx `deploy.<domain>` adresini bu sokete yönlendirir; adreste `--` olmadığı için branch adlarıyla çakışmaz.
  - Deploy anahtarları servis anahtarının kapsam modelini kullanır.
  - `deploy` = bundle + upload + `addRelease`.
- **M5:**
  - Uzak komutlar yalnızca HTTP konuşan bir Node paketine taşınır.
  - `describeApp`, tipli istemci üretimini besler.

---

## 13. Sahibe açık sorular

**Kararlar (2026-10-22):**
- Dashboard ve MCP: M4'e kadar yalnızca SSH tüneli.
- Domain ve TLS: Cloudflare'de ayrı bir alt alan (`apps.<x>`), proxied wildcard ve Origin CA (reçete A). Domain adı Faz B'den önce belirlenecek.
- VPS: Ubuntu 24.04, KVM, en az 4 GB. Branch belleği prod 512M, dev 256M.
- Alarm: ntfy.sh.
- Üretimde 0.2.0 kurulumu yok varsayıldı; `host adopt` (adım 16) kesilebilir.

1. **M4'e kadar dashboard ve MCP'ye yalnızca SSH tüneliyle erişmek kabul edilebilir mi?**
   - Önerilen: evet.
   - Telefondan erişim istenirse kontrol servisi ve owner auth öne çekilir; bu yaklaşık 6 gün ekler.
2. **Hangi domain ve TLS?**
   - Önerilen: ana iş domain'inden ayrı `apps.<x>`, Cloudflare proxied wildcard ve Origin CA (reçete A).
   - Cloudflare yoksa certbot DNS-01 ve deploy hook olarak `systemctl reload nginx`.
3. **Dağıtım, RAM ve sanallaştırma?**
   - Önerilen: Ubuntu 24.04, KVM, en az 4 GB.
   - Branch belleği: prod 512M (auth eşzamanlılığı 4), dev 256M (2).
4. **Üretimde 0.2.0 kurulumu ya da admin anahtarıyla çağrı yapan bir sunucu var mı?**
   - Varsayım: yok; adopt kesilir.
   - Varsa adopt `--keep-service-access` ile zorunlu olur.
5. **Alarm kanalı?**
   - Önerilen: ntfy.sh topic'i (`host set alert_webhook https://ntfy.sh/<rastgele>`) ile telefona push.
   - Telegram webhook'u da çalışır.

---

## Reddedilen eleştiriler

- **Bun proxy için reusePort worker havuzu:** gereksiz; nginx'in worker'ları var.
- **Drain'in işleri 120 s boyunca beklemesi:** her deploy 2 dakika sürebilir. Yerine ayarlanabilir drain ve `retryOnInterrupt` var.
- **`branch apply`:** `--restart`'sız `set`/`env` aynı işi görüyor.
- **`host init`'in ufw'yi otomatik uygulaması:** mevcut firewall'u bozabilir. Opt-in `--firewall` ve doctor kontrolü yeterli.
- **`systemd-journal` grubu:** `logs` zaten sudo ile çalışıyor.
- **Her dev release'inde preflight:** tam DB kopyası pahalı. Production'da açık, dev'de opt-in.
- **Kopya branch'te servis anahtarı yasağı:** M2'ye ertelendi. Anahtarlar zaten branch'e özel ve kopyalanmıyor.
- **Uid'nin eski dosyalarını tüm dosya sisteminde aramak:** monotonik uid ile `/var/lib/incibase` taraması yeterli.