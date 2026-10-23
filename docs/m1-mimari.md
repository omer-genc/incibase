# M1 Mimari: Projeler ve Branch'ler

Hedef sürüm incibase 0.3.0, tarih 2026-10-22. Durum: tasarım, sahibin onayını bekliyor.

Kanıt etiketleri:
- **[P]** probe ile doğrulandı.
- **[C]** koddan okundu.
- **[I]** çıkarım; sürümden önce Linux CI e2e ile doğrulanmalı.

> nginx davranışları (connect hatasının `upstream_connect_time="-"` ile ayırt edilmesi, `Set-Cookie Domain=` boşaltma, path blokları) tasarım sırasında gerçek bir nginx ile çalıştırılmadı. Adım 11'de nginx 1.24 ile doğrulandı [P]; bulunan sapmalar §5.4'teki nginx bloğunun altında.

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
3. **Proxy yerine nginx.** Restart boşluğunu istemci retry'ı kapatır. nginx bağlantının kurulamadığını `$upstream_connect_time="-"` ile ayırt eder [P].
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
| Ön kapı | nginx, statik `server` bloğu, `proxy_pass http://unix:$ib/http.sock:` | Host routing, XFF üzerine yazma, WS, `limit_req`, path blokları [P]. Reload bağlantıları düşürmez. Worker havuzu var. Proxy için ayrı bir L adımı gerekmez. |
| Restart boşluğu | `@ib_down` yalnızca `upstream_connect_time="-"` iken `503` döner, `x-incibase-unprocessed: 1` ile. İstemci 15 s boyunca jitter'la tekrar dener. | `-` (connect hatası) ile `0.000` (erken kapanma) ayrışıyor [P]. Mutation'ı tekrarlamak güvenli. |
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
| `src/host/*` | `registry`, `names`, `ops`, `driver` (testler için sahte driver), `systemd`, `render`, `nginx`, `release`, `snapshot` (+ `snapshot-command`: branch olarak koşan `incibase _snapshot`), `check`, `doctor`, `tunnel`, `cli`. |

### 3.2 Akışlar

**A. HTTP**
1. nginx TLS'i sonlandırır. `$ib` dizini yoksa 404.
2. `limit_req` uygulanır. İstemcinin gönderdiği `X-Forwarded-*`, `Forwarded`, `X-Real-IP` başlıkları silinir; yerine `$remote_addr` ve `$request_id` yazılır.
3. İstek unix soket üzerinden keepalive olmadan iletilir.
4. Branch bearer'ı çözer. `engine.call` deadline ile yarışır; aşılırsa ROLLBACK ve 504.
5. Yanıttaki `Set-Cookie Domain=` boşaltılır [P]. RFC 6265 §5.2.3'e göre boş Domain yok sayılır [I] (tarayıcıda denenmedi). **Bu bir yalıtım değil, en iyi çaba.** nginx 1.24, `Domain`'den önce ya da sonra sekme (HTAB) olan özelliği olduğu gibi bırakır (`;\tDomain=…`, `Domain\t=…`) [P]; RFC 6265 §5.2 bu boşluğu kırptığı için tarayıcı `Domain=incibase.omergenc.net`'i uygular. Tenant'ın httpAction'ı HTML sunup `document.cookie` ile de üst domain'e cookie yazabilir; bunu nginx hiç görmez. Bütün branch'ler aynı kayıtlı domain'in altında olduğundan birbirleriyle same-site'tır, SameSite da ayırmaz. Gerçek çözüm nginx'in dışında: `incibase.omergenc.net`'i Public Suffix List'in private bölümüne eklemek (ya da tenant'ları ayrı kayıtlı domain'lerde sunmak). O zamana kadar bir branch başka branch'lerin (ve üst domain'in) cookie'lerini ayarlayabilir/gölgeleyebilir; cookie'ye dayalı kimlik doğrulama bu yüzden zaten yasak (§4.1 Korunmayanlar).
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
   1. **Snapshot (ayrıcalık ayrımı, §3.2 D.3.1):** root branch'in veritabanı dosyalarını (data.db, -wal, -shm) **hiçbir zaman** ne SQLite ile ne de adıyla açmaz. Bunun yerine `incibase-snapshot@<id>` birimi, branch'in **kendi uid'siyle** ve kendi sandbox'ında (control/, backups/, trash/ erişilemez; MemoryMax; RuntimeMaxSec=900) branch'in sabitlenmiş runtime'ını `incibase _snapshot --data … --out …` olarak çalıştırır: read-only bağlantıda `trusted_schema=OFF` ile `VACUUM INTO` kopyasını branch'e ait staging dizinine (`branches/<id>/snapshot/snapshot.db`, ib-<id> 0700) yazar ve `quick_check` ile doğrular. Branch olarak koştuğu için data/'ya konan bir symlink, swap'lı -wal/-shm ya da FIFO yalnızca branch'in zaten okuyabildiğine işaret edebilir. Ardından root staging dosyasını **fd ile** içeri alır (`ingestFile`): `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` ile bir kez açar, fd'den düzenli dosya / branch uid'si / tek link / boyut / SQLite başlığı kontrol eder, backups/ altındaki root'a ait bir temp'e bayt bayt kopyalar, fsync'ler, sahip ve modu verir, yerine rename eder; staging dosyasını (tek dirent, izlenmez) unlink eder. 2×DB + 100 MB boş alan yoksa birim hiç koşmadan iptal.
   2. **Preflight:** kopya üzerinde `incibase-preflight@<id>` aynı sandbox ve MemoryMax ile `serve --migrate-only` çalıştırır. Kopya her zaman backups/ altında yapılıp preflight/'e **rename** edilir (root, branch'in kontrol ettiği bir ada asla yazmaz; tutulan snapshot varsa ondan, yoksa yukarıdaki snapshot biriminden). 64, 65, 78 veya OOM gelirse canlı branch'e dokunulmaz. Süre gate timeout'unu belirler. Kopyada `data.db` yoksa 64 döner; henüz verisi olmayan yeni bir branch'in ilk release'i `--allow-empty` ile geçer.
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
| A'nın TCP listener açması | `SocketBindDeny=any`; Ubuntu 24.04'te etkisiz (aşağıdaki not). Yerel ve özel ağdaki eşleri IPAddressDeny düşürür [P]; internete karşı host firewall'u (yalnızca 22, 80, 443) kalır. | [P]: Ubuntu 24.04'te etkisiz; sahip kararı bekliyor |
| A → bellek, CPU, PID, disk | slice, MemoryMax/High, CPUQuota, TasksMax, `max_page_count`, kota, ballast | OOM [P] |
| `.env` / `bunfig.toml` ile kalıcılık | Root'a ait cwd; ProtectSystem=strict | autoload [P] |
| Kötü niyetli release → root | Root yalnızca JSON okur; preflight branch uid'siyle sandbox'ta | test |
| İnternet → admin | Yalnızca admin.sock; `ik_admin_` 401; path blokları | test |
| Sızan servis anahtarı | Tek branch, `internal`; impersonation yok; SIGHUP ile iptal | test |
| Ön kapı DoS | nginx worker'ları, `limit_conn`, `OOMScoreAdjust=-900`, `MemoryMin=64M` | limit_req, drop-in [P]; bellek baskısı [I] |

**Korunmayanlar**
- Branch içi sırlar (loader.ts:84).
- **S3 prefix bir sınır değil.** Tenant, env'deki anahtarla kendi `S3Client`'ını kurabilir. Sınır kimlik bilgisidir: prefix'e kapsamlı IAM ya da branch başına bucket. Başka bir branch'in `S3_ACCESS_KEY_ID`'si `--shared-s3-credentials` verilmeden reddedilir.
- İnternete egress.
- Kernel LPE.
- nginx'in bearer'ları görmesi.
- Düz metin `registry.db` (M3).
- httpAction'larda ambient cookie auth: dokümanda yasaklanır.
- Branch'ler arası cookie yalıtımı: domain Public Suffix List'e girene kadar yok (§3.2 A adım 5).

**Adım 15'te doğrulanan sapmalar** (uçtan uca izolasyon; `test/host-isolation.test.ts`; OrbStack Ubuntu 24.04 arm64 LXC [P] ve GitHub Actions `ubuntu-24.04` KVM VM amd64 [I, CI koşusunda doğrulanır]):
- İki proje (alpha, beta), her biri prod ve dev; örnek uygulama alpha/prod ve alpha/dev'de, beta/dev'de ise **saldırgan** bir uygulama. Saldırının kendi fonksiyon kodu (bir httpAction, yani sandbox'ın içinde tenant olarak koşar) 4.1'deki tehdit tablosunun her satırını dener ve ne yapabildiğini raporlar; test her denemeyi bir tablo satırına çevirir ve yalnızca VIOLATED'da düşer. Her satır ENFORCED / NOT ENFORCED (bu platformda beklenen) / VIOLATED olarak sınıflanır; beklentiler platform başına açık.
- **Her yerde zorunlu (iki platformda da ENFORCED):** başka branch'in `data/`, `storage/`, env dosyası ve `control/` registry'si EACCES; `http.sock`/`admin.sock`'a bağlanmak EACCES; başka branch'in `/proc/<pid>/environ`'u EACCES (çekirdek, ProtectProc'tan bağımsız); sürecini öldürmek EPERM; kendi cwd'sine ve `/`'a yazmak başarısız, yalnızca kendi `data/`'sı yazılabilir; `/tmp` 64M'de ENOSPC; IPAddressDeny 127.0.0.1, 169.254.169.254, 10.0.0.1 ve bir IPv6 ULA'yı düşürür (timeout); `IPAddressAllow=127.0.0.53` filtrede geçer (timeout değil: dinleyen yoksa hızlı ECONNREFUSED, varsa open) ve ad çözümlenir; `CapEff=0000000000000000`; branch dosyaları 0600/0700 ve kendi uid'inde, `incibase-proxy` grubu `data/`'yı okuyamaz; bir dev branch'inin admin anahtarı prod'un admin soketinde, bir branch'in servis anahtarı başka branch'te geçmez.
- **Container'da kapalı, VM'de zorunlu (`zzz-lxc-service.conf`):** ProtectSystem (`/` yazımı VM'de EROFS, container'da yalnızca EACCES), ProtectProc (başka branch'in `/proc/<pid>`'i VM'de gizli, container'da görünür), NoNewPrivileges (VM'de `NoNewPrivs 1`, container'da 0). Test bunları container'da NOT ENFORCED, `INCIBASE_TEST_REQUIRE_SANDBOX=1` ile (VM) ENFORCED bekler.
- **SocketBindDeny iki platformda da etkisiz** (`-BPF_FRAMEWORK`): branch 0.0.0.0'da listener açabilir. Tasarımın kararı gereği bind'in başarısız olması iddia edilmez; bunun yerine `host doctor`'ın bunu `-BPF_FRAMEWORK` WARN'ı olarak raporladığı iddia edilir. `test/host-systemd.test.ts` ve `test/host-check-linux.test.ts`'in `REQUIRE_SANDBOX` yolu da SocketBindDeny'yi bu build'de muaf tutar.
- **DNS yolu platforma göre değişir, sonuç aynı:** OrbStack container'ında `resolv.conf` `0.250.250.200`'ü gösterir; bu adres deny listesinde olmadığından systemd varsayılan olarak izin verir ve ad çözülür. Gerçek VM'de stub `127.0.0.53`'tür ve `IPAddressAllow` ile açıktır. Testteki "127.0.0.53 erişilebilir" denemesi filtre semantiğini (allow → timeout değil) doğrudan ölçtüğü için iki platformda da deterministiktir.
- **Bellek:** beta/dev (256M) sınırsız ayırım yapan bir httpAction'da kendi cgroup'unda OOM ile öldürülür; alpha/prod kesintisiz hizmet verir; systemd beta'yı `Restart=on-failure` ile yeniden başlatır [P].
- **İki bilinen kırılgan testin sağlamlaştırılması (zayıflatmadan):** `test/drain.test.ts` "skipped crons" artık `top` cron'unun dakikasını saatten 30 dk uzağa koyar, böylece saat sınırında (saat sayacın ve sunucunun saati arasında dönebilir) 3 yerine 4 kaçırılan run sayılması ya da cron'un sunucu ayaktayken tetiklenmesi engellenir; sabit `topOfHour` yerine `top`'un son çalışma anından sayılır. `test/host-systemd.test.ts` "kill -9" yeni sürecin dinlemeye başlamasını 120 s'ye kadar bekler ve bu sırada eski sürecin bıraktığı sokete bağlanırken gelen ECONNREFUSED/ENOENT'i yakalar (`Type=exec`, soketi bağlamadan önce `active` olur; taze bir build'in ardından runtime sayfa cache'inde olmadığından ilk başlatma daha uzun sürebilir).

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
-- Adım 14 (user_version=2): runtimes (version PK, sha256, bytes, source, reported, installed_at): kurulu
-- runtime'lar ve doğrulandıkları sha256; layout'ta varsayılan değilse cliLink.
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
- **`incibase-snapshot@.service`**: aynı sandbox, EnvironmentFile yok, `RuntimeMaxSec=900`; yalnızca `…/%i/data` ve `…/%i/snapshot` yazılabilir. Drop-in `ExecStart=… incibase _snapshot --data …/%i/data --out …/%i/snapshot/snapshot.db`, branch User/Group ve limitleriyle.
- **Env dosyası** (0600):
  - `INCIBASE_ADMIN_KEY`, `INCIBASE_STORAGE_SECRET`.
  - `INCIBASE_SERVICE_KEYS_FILE`: `branches/<id>/service-keys.json` dosyasını gösterir (root:ib-<id> 0640; yalnızca sha256 ve kapsamlar).
  - `INCIBASE_GENERATION`, `INCIBASE_BRANCH_LABEL`/`KIND`, `TZ`.
  - `INCIBASE_MAX_{DB,STORAGE,UPLOAD}_BYTES`, `INCIBASE_AUTH_CONCURRENCY`.
  - `INCIBASE_S3_PREFIX`, `S3_*` ve uygulama env'leri.

**Adım 10'da doğrulanan sapmalar** (OrbStack Ubuntu 24.04, systemd 255):
- `TemporaryFileSystem=/tmp:size=64M,mode=1777` [P]. Seçeneksiz tmpfs root 0755 bağlanıyor; branch kullanıcısı `/tmp`'ye yazamıyordu.
- **Ayrıcalık ayrımlı snapshot (m1b).** Eski akışta root, `openPinned` (O_NOFOLLOW) ile data.db inode'unu sabitleyip SQLite'a `/proc/self/fd/N` yolunu veriyordu; ancak SQLite'ın unix VFS'i veritabanı yolundaki symlink'i çözüp (`unixFullPathname`) **adıyla** yeniden açıyor ve `-wal`/`-shm`'yi de adıyla açıyordu, dolayısıyla bir tenant root'un okumasını başka bir branch'e ya da kontrol düzlemine yönlendirebiliyordu (gerçek VM'de `leaked=5`; container'da data.db flip yarışı `leaked≥1` [P]). Artık kopya `incibase-snapshot@<id>` biriminde branch uid'siyle alınır ve root staging dosyasını yalnızca fd ile içeri alır (yukarıda §3.2 D.3.1). `openPinned` kaldırıldı. Birim `Type=exec`, `RuntimeMaxSec=900`, EnvironmentFile yok (kopya sır istemez), yalnızca `data/` ve `snapshot/` yazılabilir. `data/` yazılabilir çünkü SQLite'ın okuyucusu WAL modunda `-shm`'yi map'ler. `provision`/`render` branch ağacına `snapshot/` (ib-<id> 0700) ekler; eski branch'lerde `host render` onu oluşturur. `host-snapshot-linux.test.ts` branch uid'siyle root'a karşı yarışan bir saldırı paketidir (data.db/-wal/-shm symlink'leri, staging çıktısının /etc/shadow'a / registry'ye / başka branch'e symlink'i, FIFO, hard link, dev sparse dosya, SQLite olmayan dosya): benzersiz bir sır markerının hiç sızmadığını, asılı kalınmadığını ve gerçek snapshot + restore'un hâlâ çalıştığını doğrular; VM'ye bağlı değildir (container'da da 4/4 geçer).
- `incibase-preflight@.service` `Type=exec`, oneshot değil [P]: systemd `Type=oneshot` ile `RestartForceExitStatus=` kabul etmiyor ("isn't allowed for Type=oneshot services. Refusing"). Job, unit bitene kadar `systemctl show`'u yoklar; asılı kalan preflight'ı `RuntimeMaxSec=900` durdurur. Başarılı bir `Type=exec` unit'i bittikten sonra `ExecMainCode=0` gösterir, 1 değil [P]. Aynısı `incibase-snapshot@.service` için de geçerli.
- `INCIBASE_GENERATION` env dosyasında değil, drop-in'de `Environment=` olarak durur; env dosyası release'ler arasında değişmez.
- Unit adları bir önekten gelir (varsayılan `incibase`): test host'ları `incibase-s10-branch@<id>.service` gibi kendi adlarını kullanır. `incibase-s10.slice` systemd'nin ad hiyerarşisi yüzünden `incibase.slice`'ın altına düşer.
- Gate, generation'ı en az 1 s arayla iki kez ve arada restart olmadan görmeden geçmez: hazır olup hemen çöken bir release'i yakalar. `migration_committed`, restart'tan önce alınan journal cursor'ından sonraki ve sürecin kendisinin yazdığı (`_SYSTEMD_INVOCATION_ID` olan) satırlarda, en üst düzeyde `ev` olarak aranır; uygulamanın `console` çıktısı sayılmaz. `journalctl -o json` 4096 byte'tan uzun alanları `--all` olmadan `null` basıyor [P].
- Çöken release: `Restart=on-failure` ile 8 restart, ≈19 s içinde `failed` (`NRestarts=8`) [P]; migration commit edilmediği için önceki release'e dönülür.
- `env set` satır sonu ve sekme dışındaki kontrol karakterlerini reddeder. systemd tırnak içindeki satır sonunu değerin parçası sayıyor [P], ama dosyada kendi başına değişken gibi okunan bir satır oluşurdu; çok satırlı değerler base64 ile verilir.
- Onay kelimesi branch'in hostname'idir (`prod--shop.<domain>`). Silme, korunmasa da her production branch'inde onay ister.
- Release olmadan drop-in'de `ExecStart` yok; unit `bad-setting` görünür ve başlamaz [P]. `systemctl reset-failed` yüklenmemiş bir instance için 1 ile çıkar, `stop` 5 ile [P].
- OrbStack container'ında `/run/systemd/system/service.d/zzz-lxc-service.conf` her servis için ProtectSystem, ProtectHome, PrivateDevices, NoNewPrivileges, ReadWritePaths ve ProtectProc'u kapatıyor. SocketBindDeny de etkisiz, ama sebebi container değil (adım 13 düzeltmesi): Ubuntu 24.04'ün systemd paketi BPF framework'süz derlenmiş (`systemctl --version`: `255.4-1ubuntu8.18 … -BPF_FRAMEWORK`) ve SocketBindDeny buna muhtaç; aynı paket KVM VM'de de çalışır [P, arm64; adım 15 amd64'te doğrular]. Etkili olanlar: IPAddressDeny (127.0.0.1 ve 169.254.169.254 zaman aşımı), TemporaryFileSystem, InaccessiblePaths, boş CapabilityBoundingSet [P]. `test/host-systemd.test.ts` hangi direktifin etkisiz olduğunu ve onu neyin kapattığını raporlar; adım 15'teki gerçek VM'de `INCIBASE_TEST_REQUIRE_SANDBOX=1` ile hepsi zorunludur.

**`/etc/nginx/conf.d/incibase.conf`** (branch başına satır içermez; tasarımdaki hali, render edilen tam metin `test/host-nginx.test.ts`'te, farklar aşağıda):
```nginx
map $http_upgrade $ib_conn { default upgrade; "" close; }
limit_req_zone  $binary_remote_addr zone=ib_ip:20m rate=50r/s;
limit_req_zone  $binary_remote_addr zone=ib_auth:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=ib_ipc:10m;
limit_conn_zone $ib_label zone=ib_br:10m;
server {
  listen 443 ssl http2;
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
    if ($upstream_connect_time != "-") { add_header Access-Control-Allow-Origin * always; return 502; }
    add_header Access-Control-Allow-Origin * always; add_header Access-Control-Expose-Headers x-incibase-unprocessed always;
    add_header Access-Control-Allow-Headers "authorization, content-type, x-incibase-as-user" always;
    add_header Retry-After 1 always; add_header x-incibase-unprocessed 1 always;
    if ($request_method = OPTIONS) { return 204; }
    default_type application/json; return 503 '{"error":{"code":"BRANCH_UNAVAILABLE"}}';
  }
}
```

`@ib_down` CORS başlıklarını kendisi ekler ve OPTIONS'a 204 döner [P]. Bu olmasa tarayıcı, restart sırasında preflight'ı başarısız sayar ve istemci yalnızca bir `TypeError` görür; 503'ü hiç okuyamaz.

Ayrıca render edilenler:
- Sertifika.
- Bilinmeyen SNI için `ssl_reject_handshake`.
- `$uri` ile JSON log.
- Cloudflare için `real_ip_header`.
- Alias `server` blokları.
- nginx için `OOMScoreAdjust=-900` drop-in'i.

**Adım 11'de doğrulanan sapmalar** (OrbStack Ubuntu 24.04, nginx 1.24.0; `test/host-nginx-linux.test.ts`, kök `/var/lib/incibase-n11`, kendinden imzalı `*.incibase.omergenc.net` sertifikası, gerçek bir dev branch'i, `curl --resolve` ile https):
- **`@ib_down`'daki `if` bloğu location'ın `add_header`'larını miras alıyor** [P]. Tasarımdaki haliyle, kabul edip erken kapanan bir upstream'in 502'si de `x-incibase-unprocessed: 1` ve `Retry-After: 1` taşıyordu; istemci, işlenmiş olabilecek bir mutation'ı yeniden gönderirdi. `if` bloğuna kendi `add_header`'ı (`Access-Control-Allow-Origin *`) kondu: miras kesilir, tarayıcı 502'yi okuyabilir, unprocessed işareti yok [P].
- `$upstream_connect_time`: soket dosyası yokken (durdurulmuş branch) ve dosya kalmış ama dinleyen yokken (ECONNREFUSED, SIGKILL sonrası) `-` → 503-unprocessed; kabul edip kapatan upstream `0.000` → 502 [P]. Her ikisinde `$upstream_status` 502.
- `http2 on;` nginx 1.25.1'de geldi; Ubuntu 24.04'ün 1.24'ü için `listen … ssl http2` yazılıyor (yenilerde yalnızca uyarı) [P].
- `proxy_cookie_domain ~.+ ""` özelliği silmiyor, boşaltıyor: `sid=1; Domain=; Path=/; HttpOnly` [P]. Boş Domain'in yok sayılması RFC 6265 §5.2.3'e dayanır, tarayıcıda denenmedi [I]. Sekmeli biçimler (`c6=1; Path=/;\tDomain=…`, `c8=1; Path=/; Domain\t=…`) değişmeden geçiyor [P]; Linux testi bunu bilinen açık olarak olduğu gibi doğrular. Yalıtım değil (§3.2 A adım 5).
- Bilinmeyen SNI, SNI'siz (IP ile) bağlantı, çıplak domain ve `deploy.<domain>`: `ssl_reject_handshake`, curl çıkış 35 "unrecognized name" [P]. Bilinmeyen label (`nope--shop`) 404 JSON [P]. Branch'in SNI'siyle gelip başka Host gönderen istek default server'a düşer ve `444` ile kapanır.
- Path blokları `$uri` (çözülmüş, birleştirilmiş eğik çizgi) üzerinde eşleştiği için `/%5F/` ve `/api//admin/x` de nginx'te 404 [P]; access log'da upstream boş. `/_foo` branch'e gider.
- Uygulamanın gördüğü: `X-Forwarded-For: 127.0.0.1` (istemcinin `6.6.6.6`'sı değil), `X-Forwarded-Proto: https`, kendi `Host`'u, 32 hex `x-request-id` (istemcininki değil), `Connection: close`; `X-Real-IP`, `Forwarded`, `X-Forwarded-Host`, `CF-Connecting-IP` yok [P]. Silinen başlıklar listesi genişletildi: `X-Forwarded-Host/Port/Prefix/Server/Scheme/Ssl`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`. `X-Accel-Redirect` ve benzerleri yok sayılır: tenant nginx'e başka bir şey sundurmaz.
- nginx'te zone, `map` değişkeni ve `log_format` adları globaldir: önekten türetilir (`incibase_ip`, `$incibase_connection`, `incibase_json`; `incibase-n11` öneki için `incibase_n11_…`), böylece iki host bir nginx'i **yalnızca farklı portlarda** paylaşabilir: her host kendi portu için `ssl_reject_handshake`'li `default_server`'ı render eder, aynı portta ikincisi tüm config testinde "a duplicate default server" ile reddedilir ve eski dosyası kalır. `$ib`/`$ib_label` paylaşılabiliyor.
- **Log izinleri.** nginx (adayın `nginx -t`'si de) olmayan bir log dosyasını root 0644 açıyor; branch sandbox'ı `/var/log`'u gizlemediği için her tenant başka tenant'ların istek meta verisini (IP, label, path, request id) okuyabiliyordu. Render ve aday testi artık `<önek>.access.log` ve `<önek>.error.log`'u nginx açmadan önce logrotate'in yaptığı gibi `www-data:adm 0640` oluşturuyor, sapınca düzeltiyor; branch unit'ine ayrıca `InaccessiblePaths=-/var/log/nginx` eklendi. Branch uid'si iki log'da da Permission denied alıyor, branch'in mount namespace'inde `/var/log/nginx` boş [P].
- **Error log'da query string.** Access log query string'i atıyor ama nginx'in error log'u her başarısız connect'te ([crit]/[error]) istek satırını query string'le yazıyordu (yükleme token'ları). Server bloğunun kendi `error_log <önek>.error.log alert;`'i var; bu hatalar access log'da query'siz zaten var (status, upstream, connect). Durdurulmuş branch'e `?token=…` ile yükleme: token hiçbir log'da yok [P]. Uzun vadede token header'a taşınmalı.
- **nginx'in kendi 429/413'ü.** `limit_req`/`limit_conn` 429'u ve `client_max_body_size` 413'ü nginx'in HTML sayfasıydı, CORS'suz; tarayıcı yalnızca `TypeError` görüyordu. `error_page 429 = @ib_limited` ve `error_page 413 = @ib_too_large`: serve'ün biçiminde JSON (`RATE_LIMITED`, `PAYLOAD_TOO_LARGE`), CORS başlıkları, `x-request-id`, 429'da `Retry-After` (auth yollarında 6, diğerlerinde 1); sınıra takılan bir preflight 204 alır, böylece tarayıcı asıl isteğin 429'unu okuyabilir [P]. Preflight'lar auth zone'unu harcamıyor (`OPTIONS` için anahtar boş): her sign-in'den önce preflight ile 10 deneme yine 6 geçti, 4 × 429 [P].
- **IPv6 /64.** Zone'lar `$binary_remote_addr` (IPv6'da /128) yerine `map $remote_addr $<önek>_client` ile IPv4 adresine ve IPv6'nın /64'üne göre sayıyor; nginx'in sıkıştırılmış yazımının (`::`) her biçimi için kurallar `CLIENT_KEY_MAP`'te, macOS testi nginx'in `ngx_inet6_ntop`'unu taklit eden 20 000 rastgele adresle doğruluyor. Aynı /64'ten iki adresle dönüşümlü 8 sign-in: 6 geçti, 2 × 429; sonraki /64'ün kendi bütçesi var [P].
- Yükleme stream'i artık nginx worker'larının `/var/lib/nginx/body/` altında açık tuttuğu (silinmiş) dosyalara bakarak doğrulanıyor (error log artık `alert` seviyesinde): `/api/mutation`'a yavaş 1,5 MB'lık kontrol isteği spool'lanıyor, 50 MB'lık yükleme hiç spool'lanmıyor [P].
- `limit_conn` (IP başına 200, branch başına 5000) yalnız `/api/ws`'te değil server düzeyinde, `limit_conn_status 429`. Auth location'ında iki zone birden; ardışık 10 sign-in: 6'sı geçti (1 + burst 5), sonrası 429 [P].
- WebSocket: nginx üzerinden `101 Switching Protocols` ve iki yönlü mesaj [P].
- 50 MB yükleme 200 döndü, gövde stream edildi (spool kontrolü aşağıda) [P]. Başka bir yola 3 MB gövde 413, JSON `PAYLOAD_TOO_LARGE` ve CORS ile [P].
- `trust_proxy=cloudflare`: aralıklar kodda sabit (`CLOUDFLARE_RANGES`, cloudflare.com/ips-v4 ve ips-v6'dan 2026-10-23'te alındı; güncelleme komutu sonra, adım 13). Cloudflare dışından gelen `CF-Connecting-IP`'ye inanılmıyor [P]; Cloudflare üzerinden gerçek istek adım 15'te.
- Render sırası: aday dosya, yalnızca onu içeren küçük bir ana config ile `nginx -t -c` (control/nginx/ altında); geçerse atomik olarak yerine konur ve tüm config `nginx -t`; o da geçmezse eski dosya (ve `setFrontDoor`'da registry) geri gelir [P]: port 80 denemesi "a duplicate default server for 0.0.0.0:80" ile reddedildi, nginx eski dosyayla sundu. nginx yalnızca dosya (ya da www-data'nın grupları) değiştiğinde reload edilir; değişiklik yoksa worker PID'leri aynı [P].
- `www-data` `incibase-proxy` grubuna `usermod --append` ile girer; reload'da master yeni worker'lar için `initgroups()` çağırdığından restart gerekmez (worker'ların `Groups:` satırında gid var) [P].
- nginx drop-in'i `nginx.service.d/50-<önek>.conf`: `OOMScoreAdjust=-900`, `MemoryMin=64M`. OOMScoreAdjust master başlarken uygulanır; drop-in değişince nginx restart edilir (bir kez, init'te). OrbStack'te master'ın `oom_score_adj`'ı -900 oldu [P].
- TLS (reçete A): `host init --tls-cert/--tls-key` (ops `initHost` `tlsCert`/`tlsKey`, sonra `setTls`). Sertifika `*.<domain>`'i kapsamalı, anahtar eşleşmeli, süresi geçerli olmalı. `<kök>/tls/` (root 0700) altına çiftin sha256'sından `<sha16>.crt` (0644) ve `.key` (0600) olarak kopyalanır; registry `tls_cert`/`tls_key` ancak aday nginx testinden geçince değişir. Rotation = yeni çift + test + reload, sonra eski çift silinir; nginx yarım bir rotation görmez [P] (yeni parmak izi sunuldu, worker'lar yenilendi).
- Alias `server` blokları bu adımda yok: registry'de alias tablosu yok (§11'deki kesme listesinde).
- Ayarlar: `domain`, `trust_proxy` (`none`|`cloudflare`), `tls_cert`, `tls_key`, `https_port` (varsayılan 443; testler kendi portunu kullanır). Op'lar: `setTls`, `setFrontDoor`, `renderNginx`; `render` sonda nginx'i de render eder, hatası raporda `nginx.error` olur.

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
      snapshot/   ib-<id> 0700            incibase-snapshot@<id>'nin yazdığı staging kopyası (snapshot.db)
      run/http/   ib-<id>:incibase-proxy 2750;  run/admin/  ib-<id>:incibase-admin 2750
  backups/<id>/pre-<seq>.db  root 0600    (production, son 3)
  trash/     root 0700                    yalnızca production silmeleri, 7 gün
  tls/       root 0700                    <sha16>.crt 0644, <sha16>.key 0600 (nginx'in sunduğu çift)
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

**Adım 14'te doğrulanan sapmalar ve ayrıntılar** (runtime pinleme; OrbStack Ubuntu 24.04 arm64, systemd 255):
- Release workflow'u binary'lerin yanına `SHA256SUMS` (sha256sum biçimi, düz dosya adları) yazar ve GitHub Release'e ekler.
- `host install-runtime --version <x.y.z> [<binary> (--sums <SHA256SUMS> | --sha256 <hex>)] [--skip-version-check]`:
  - Yerel dosya her zaman bir checksum ister: `--sums`'taki dosya adı girdisi ya da `--sha256`. Checksum'sız kurulum yok.
  - Binary verilmezse `https://github.com/omer-genc/incibase/releases/download/v<x.y.z>/` altından önce `SHA256SUMS`, sonra `incibase-linux-<x64|arm64>` indirilir. Girdisi olmayan, 404 veren, eksik inen (Content-Length tutmayan) ya da https dışına yönlenen indirme reddedilir. Yönlendirmeler tek tek izlenir (en çok 5) ve yalnızca sonuncusu değil her adım kontrol edilir: araya giren tek bir düz http adımı zincirin geri kalanını başka yere gönderebileceğinden, her `Location` https olmalıdır (http yalnızca indirme loopback'te başladıysa ve hedef de loopback'teyse). Base URL yalnızca testler için değişir (http yalnızca loopback'te).
  - Baytlar sürüm dizininde root-only (0700) geçici bir dosyaya iner ya da kopyalanır, hash'lenir; eşleşmezse silinir ve **hiç çalıştırılmaz**. Eşleşince 0755 yapılır, `--version` sorulur, tek bir `rename` ile `<runtime root>/<ver>/incibase` olur ve registry'ye yazılır [P].
  - Aynı baytlar tekrar: hiçbir şey değişmez, indirme de yapılmaz. Kurulu bir sürüm başka baytlarla asla değiştirilmez (CONFLICT); diskte bozulmuşsa kayıtlı sha256'yla aynı baytlar geri konabilir.
  - Yarıda öldürülen bir kurulumun (SIGKILL, OOM, reboot, kopan SSH; indirme 15 dakikaya kadar sürebilir) geçici `.incibase-<hex>.partial` dosyası, hiçbir kurulumun sürmeyeceği kadar eskiyince (indirme zaman aşımı + 10 dakika, mtime'a göre) silinir: aynı sürümün sonraki kurulumu kendi dizininde, `host gc` bütün sürüm dizinlerinde. gc ayrıca kaydı olmayan ve bunlardan başka bir şey içermeyen sürüm dizinlerini de siler; daha taze bir dosya hâlâ inen bir kurulumun olabileceği için bırakılır [P].
  - Diskte duran ama registry'de kaydı olmayan bir runtime (elle kopyalanmış ya da sürümler kaydedilmeden önce kurulmuş) da başka baytlarla değiştirilmez: hash'i beklenenle aynıysa kurulum onu kaydeder, değilse CONFLICT verir (indirmede binary inmeden önce). `host gc` böyle dizinlere dokunmaz, `unrecorded` olarak listeler.
  - `--skip-version-check` aynı build'i başka bir sürüm adıyla kurar (Linux testi bununla ikinci bir "sürüm" kurar); binary'nin söylediği `runtimes.reported`'da ve audit'te kalır. Binary yine de `--version`'a 0 ile cevap vermelidir.
- `host use-cli <version> [--replace]`: `/usr/local/bin/incibase`'i (layout'ta `cliLink`) kurulu bir runtime'a atomik symlink yapar; elle kopyalanmış bir dosyanın yerine yalnızca `--replace` ile geçer. settings'te `cli_version` tutulur.
- Pinleme: `upgradeBranch` ve `runtimeVersion` verilen `createBranch` yalnızca registry'de kayıtlı ve dosyası duran runtime'ları kabul eder (NOT_FOUND); upgrade bunu lock altında bir kez daha kontrol eder. Bozuk bir runtime'a upgrade gate'te düşer ve pin geri alınır [P].
- `host gc` = trash temizliği + `gcRuntimes`: silinmemiş hiçbir branch'in pinlemediği, CLI link'inin ve çalışan sürecin göstermediği kayıtlı runtime'ları siler (önce registry satırı, sonra dizin). Bir branch upgrade job'ındayken (hedefi henüz pin değil) hiçbir şey silmez. Bir runtime root tek bir host'undur: gc yalnızca kendi registry'sindeki pinleri saydığından, root'u paylaşan iki host birbirinin branch'lerinin çalıştırdığı runtime'ları silerdi. Bu yüzden ilk kurulum root'a host root'unu yazan bir `.incibase-host` dosyası koyar; başka bir host'un adını taşıyan bir root'ta kurulum (hiçbir şey indirmeden) ve gc CONFLICT ile reddedilir. O host yoksa dosya elle silinir. Test host'ları kendi runtime root'larını kullanır.
- `host install-runtime | use-cli | runtimes | gc` kendi bayraklarını okur; `host op` aynı op'ları (`installRuntime`, `useCli`, `listRuntimes`, `gcRuntimes`, `gc`) JSON ile çağırır.

**Adım 12'de doğrulanan sapmalar ve ayrıntılar** (sahip CLI'ı ve tünel; OrbStack Ubuntu 24.04 arm64, systemd 255, nginx 1.24):
- Komutlar `src/host/commands.ts`'te, her biri ops.ts'teki bir iki op'un üstünde ince bir katman. Hepsi `--root`, `--json` (op'un sonucu stdout'a JSON; ilerleme satırları ve notlar stderr'e) ve `--help` alır. Çıkış kodları: 0 tamam, 1 başarısız ya da reddedildi (gate düşmesi, release `failed`, doctor FAIL dahil), 2 kullanım (bilinmeyen bayrak, eksik argüman, geçersiz ad/değer, op'un `INVALID`'i). Eski `host op` ve runtime komutlarının 64'ü 2 oldu; `runtime-cli.ts` commands.ts'e katıldı. Hata tek satırdır (`incibase <komut>: <mesaj>`), `--json`'da stderr'e `{"error":{code,message}}`.
- Kullanım hataları root ve host'a bakılmadan döner: argüman ve ad kontrolleri gibi yalnızca bayraklara bakan kontroller de (zorunlu bayraklar, sayı/boyut/on-off ayrıştırma, `host set` anahtarı, servis anahtarı id'si) her komutun `check` kancasında root kontrolünden önce çalışır, root olmayan biri de 2 alır. Geri kalan her komut root ister ve bunu söyler (`… runs on the server as root: sudo incibase …`, çıkış 1). `tunnel` root istemez.
- `host init` dışındaki hiçbir komut kurulmamış bir root açmaz: `<root>/control/registry.db` yoksa ya da registry'de kaydedilmiş `layout` yoksa `No incibase host at <root>: run sudo incibase host init …` (çıkış 1). `Registry.open` eksik registry'yi yarattığından yanlış yazılmış bir `--root` önceden boş bir host doğuruyordu (`status` "No branches" ile 0, `project create` başarılı) [P].
- `admin-key` iki anlamlıdır ve argüman biçimi ayırır, bayrakların yeri fark etmez: `/` içeren bir konumsal argüman (`--data`, `--root` gibi değer alan bayrakların değeri sayılmaz) ya da yalnızca hosted'da olan bir bayrak (`--rotate`, `--root`, `--json`) varsa hosted branch (`admin-key [--root dir] shop/prod [--rotate]`), yoksa eskisi gibi `--data` dizinindeki yerel uygulama. Hosted bir işaretle `--data` birlikte kullanım hatasıdır (2). `admin-key` ve `service-key create` stdout'a yalnızca anahtarı yazar (`$(ssh vps sudo incibase admin-key shop/prod)` çalışsın diye); açıklama stderr'e. Servis anahtarı yalnızca bir kez gösterilir.
- `host add-admin <kullanıcı>`: `usermod --append --groups <admin grubu>`; yalnızca giriş hesapları (uid 1000–59999, login.defs). Branch kullanıcıları, nginx'in ve diğer sistem hesapları reddedilir: admin grubu her branch'in admin soketine ulaşır. Grup bir sonraki SSH girişinde geçerli olur [P].
- `project delete <slug>` yalnızca canlı branch'i kalmamış projeyi siler: production verisi tek komutta, onaysız gitmesin diye branch'ler `branch delete` ile (prod için `--confirm <hostname>`) tek tek silinir. Silinen branch satırları projeyi andığından satır kalır: registry user_version=3, `projects.deleted_at`. Aynı slug ile `project create` projeyi yeniden canlandırır.
- Bayraklar: `branch create [--kind] [--protected|--unprotected] [--runtime]`; `branch set [--memory --memory-high --cpu --tasks --max-db --max-storage --max-upload --timeouts --drain-timeout --preflight on|off --protected on|off --confirm --restart]`; `branch upgrade --runtime <x.y.z>`; `release rollback [--to n] [--restore] [--snapshot pre-N] [--confirm]` (`--restore` = mevcut release'ten önceki snapshot, `pre-<mevcut seq>`); `env set|unset|import … [--restart]`; `logs [-f] [--errors] [--since] [--lines]`. Ek olarak `host tls --cert --key` ve `host set trust_proxy|https_port` (alert_webhook'un yanında).
- `release add … -` bundle'ı stdin'den okur (en çok 64 MiB), root'a ait 0700 bir geçici dizine yazar, origin `cli:stdin` olur. Yardım `ssh -t … - < app.ib` önermez: stdin yönlendirilmişken tek `-t` pty ayırmaz (ssh uyarır), `sudo` yine parola soramaz; `-tt` ise bundle'ı pty'nin satır disiplininden geçirir [P]. Yardım `scp app.ib vps: && ssh -t vps sudo incibase release add shop/prod app.ib`'i, stdin biçimi için parolasız sudo gerektiğini yazar. `env set` yardımı sırlar için `env import <p>/<b> -`'i (stdin) önerir: komut satırındaki değer sudo'nun loguna ve `ps`'e düşer.
- `env import`: .env satırları; boş satır ve `#` yorum atlanır, `export ` önekine izin var, çift tırnak (`\"`, `\\`, `\$`), tek tırnak (düz) ve tırnaksız değer (` #`'ten sonrası yorum). Çok satırlı değer (kapanmayan tırnak, çift tırnakta `\n`) satır numarasıyla reddedilir; aynı ad tekrar edilirse sonuncusu geçer. Hepsi tek `envSet`, yani biri geçersizse hiçbiri yazılmaz. `env import`, `env list|unset` ve `release add` mevcut release'in `manifest.envNames`'inde olup branch'te olmayanlar için stderr'e uyarı yazar.
- `logs --errors` = `journalctl --grep '"level":"error"'` (branch'ler JSON log yazar); `--json` = `journalctl --output json`. journalctl'ın stdout'u terminale miras verilmez: `--output cat` MESSAGE baytlarını ham yazar, yani tenant'ın ESC/BEL dizileri (OSC başlık/pano, ekran silme) root'un terminaline ulaşırdı [P]. Satırlar okunup `printable()`'dan geçer (sekme kalır, diğer C0/C1 kontrol karakterleri `?`), `-f`'te akarak; 64 KiB'tan uzun satır bölünür. `--grep` eşleşme yoksa stderr'e bir şey yazmadan 1 döner [P]: `--errors` ile 1 yalnızca stderr boşsa başarıdır. journalctl'ın okuyamadığı bir `--since` (SINCE desenine uyan `abc` gibi) de 1 döner (`Failed to parse timestamp: abc`) [P]; bu artık `--errors` ile ya da onsuz kullanım hatası (2).
- `incibase status` tablo: BRANCH, KIND, DESIRED, ACTUAL (`activeState/subState`), RELEASE, GENERATION, MEMORY (`MemoryCurrent/MemoryMax`), URL; altında firing alarmlar.
- `incibase tunnel <p>/<b> --ssh <hedef> [--open] [--local-port n] [--root dir] [--ssh-config dosya] [--timeout s] [--json]`: önce `ssh -o ConnectTimeout=15 -- <hedef> cat <root>/admin/index.json`, girdideki soket adını (`<label>.sock`) ve portu doğrular, yerel port doluysa ssh başlatmadan reddeder, sonra `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:<port>:<root>/admin/<label>.sock -- <hedef>`. `/api/health` 200 dönene kadar bekler (ssh erken çıkarsa ya da süre dolarsa ssh'i durdurup 1 ile çıkar), dashboard URL'ini, `claude mcp add …` komutunu ve admin anahtarını alacak `ssh <hedef> sudo incibase admin-key …` komutunu yazar. Ctrl-C (ve SIGTERM/SIGHUP) ssh'i SIGTERM ile kapatır, çıkış 0. Hedef `user@host` ya da config alias'ı olmalı (`-` ile başlayamaz), root ve config yolu güvenli karakterlerle sınırlı; ssh'e argüman dizisi gider, admin anahtarı tünelden geçmez. `--ssh-config` (`ssh -F`) eklendi: ~/.ssh/config'e dokunmadan başka bir config kullanmak için. İki ssh çağrısı da `-o ControlMaster=no -o ControlPath=none` alır: kullanıcının config'inde `ControlMaster auto` + `ControlPersist` varsa `cat` çağrısı arka planda bir master başlatıyor, `ssh -N -L` de mux istemcisi olarak yönlendirmeyi o master'a verip hemen 0 ile çıkıyordu; tünel "reachable" yazıp "ssh exited 0" ile düşüyor, 127.0.0.1 portu ise master'da ControlPersist boyunca açık kalıyordu, Ctrl-C kapatamıyordu [P].
- Tünel macOS'tan VM'e gerçekten denendi [P]: OrbStack'in SSH'ı (`-F ~/.orbstack/ssh/config`, `<kullanıcı>@<makine>@orb`) unix sokete `-L` yönlendirmesini destekliyor. `host add-admin` ile admin grubuna eklenen root olmayan bir kullanıcıyla dev branch'in admin soketine tünel açıldı: `/api/health` 200 (generation ile), `/_/` 200, `/mcp` cevap verdi; Ctrl-C sonrası ssh kapandı ve port boşaldı. Admin grubunda olmayan bir hesap (nobody) admin soketine ulaşamıyor [P]. OrbStack girişi kullanıcıya `systemd --user` bıraktığından test temizliği `loginctl terminate-user` ile başlar.
- Linux'ta (test/host-cli-linux.test.ts) yalnızca CLI ile uçtan uca: self-signed sertifikayla `host init` (nginx kendi portunda), runtime kurulumu, `project create shop --branches prod,dev`, dev'e dosyadan, prod'a stdin'den (preflight ile) release, iki branch https üzerinden 200 ve bilinmeyen 404, service-key create/list/revoke (reload onaylı), `env set` önce restart'sız (generation aynı) sonra `--restart` (yeni generation), `status`, `host status`, `logs` (`"ev":"ready"`; `logger --journald` ile branch unit'ine yazılan ESC/BEL'li bir satır `?` ile çıkar; `--since abc` `--errors` ile de 2), init'ten önce ve yanlış bir `--root`'ta komutların registry yaratmadan reddi, `branch delete` (prod `--confirm` ile) ve `project delete` [P]. Tünel, `ControlMaster auto` + `ControlPersist 120` içeren bir ssh config'iyle (`--ssh-config`) admin kullanıcısıyla macOS'tan yeniden denendi: tünel ayakta kaldı, `/api/health` 200, ControlPath'te master soketi oluşmadı, SIGINT 0 ile çıktı ve port boşaldı [P].

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
  - ProtectProc ve ProtectSystem etkisiz. `zzz-lxc-service.conf` ProtectSystem=no ve ProtectProc=default yazıyor.
  - SocketBindDeny etkisiz, ama container yüzünden değil: `zzz-lxc-service.conf`'ta SocketBind ayarı yok. Ubuntu 24.04'ün systemd'si `-BPF_FRAMEWORK` ile derlenmiş ve SocketBindDeny BPF framework ister. `SocketBindDeny=any` ile `nobody` olarak açılan transient unit 0.0.0.0:0 ve 0.0.0.0:18431'i direktif yokmuş gibi bağladı. Aynı paket KVM VM'de de koşar, yani hedef host'ta da etkisizdir.
  - IPAddressDeny etkili. Branch sandbox'ının IPAddressDeny'ı gelen paketleri de düşürür: 0.0.0.0:18433'te dinleyen unit'e root'tan 127.0.0.1 ve 192.168.x adresiyle bağlanma zaman aşımına uğradı; direktifsiz unit cevap verdi. Bir branch'in TCP listener'ına yerel ve özel ağdaki eşler (diğer branch'ler, nginx) ulaşamaz; açık kalan, public IP üzerinden internet.
  - Container'da etkisiz direktif WARN olarak raporlanır, VM'de FAIL. İstisna: `systemctl --version` `-BPF_FRAMEWORK` gösteriyorsa SocketBindDeny VM'de de container'da da "unsupported by this systemd build (-BPF_FRAMEWORK)" WARN'ıdır ve container suçlanmaz. Böylece Ubuntu 24.04 VM doctor'dan geçebilir.
- **Sahip kararı bekliyor (TCP listener tehdidi):** Ubuntu 24.04'te `SocketBindDeny` hiçbir yerde çalışmadığı için 4.1'deki satırın yerine geçecek kontrol seçilmeli. Öneri: host firewall'u yalnızca 22, 80 ve 443'e izin versin (`host init --firewall`) ve doctor bunu denetlesin. RestrictAddressFamilies yetmez, çünkü branch'in dışarıya AF_INET bağlantısı gerekir. Karar verilene kadar doctor bu durumu WARN sayar; FAIL'e çevirmek tek satırlık değişikliktir. Seçilen kontrolün testi o adımda eklenir. Adım 15'te `INCIBASE_TEST_REQUIRE_SANDBOX=1` ile `test/host-systemd.test.ts` SocketBindDeny yüzünden düşer; o adım da aynı karara bağlıdır.
- Doctor'ın disk eşikleri: %90 kullanımda WARN, %95'te FAIL. systemd için alt sınır 252.
- Review düzeltmeleri:
  - **Öldürmeden önce yeniden bakılır.** `killMain`'den hemen önce `show` tekrarlanır. Unit hâlâ `active` değilse ya da `InvocationID` veya MainPID, başarısız probe'lardakinden farklıysa öldürme yapılmaz (`transition`, "restarted while it was probed"). Bu durum, probe beklerken sahibin `branch restart`'ı ya da bir crash ve Restart= ile olur. Yeni süreç sıfırdan sayılır.
  - **İki check aynı anda koşmaz.** Her çalıştırma `control/check.lock`'u (root 0600, `DataDirLock` ile aynı yöntem) tutar. Kilidi tutulmuş bulan çalıştırma hiçbir şey yapmaz ve "skipped another check is running" yazar. oneshot servis yalnızca timer'ı sıraya koyuyordu; elle çalıştırılan `host check` timer'ınkiyle çakışabiliyordu.
  - **POST sırasında kapanan alarmın kapanışı da gider.** Açılış POST'u sürerken alarm resolve olursa (`since` değişir), `markAlertNotified` firing satırını bulamayınca aynı anahtarın `resolved` ve `notified_at` NULL satırını işaretler. Önceden bu satır sessizce kapanıyordu ve sahip alarmı açık sanıyordu. Şema değişmedi.
  - **Disk alarmı histerezisle kapanır.** `disk:<p>` alarmı kullanım `p` − 3 puana (≤ %77 / ≤ %87) inince kapanır. Önceden %80 civarında salınan kullanım her 30 s'de bir bildirim üretiyordu.
  - **Yavaş crash loop alarmı.** `restarts:<id>`, branch başına `NRestarts`'tan sayılır ve sayaç `check-state.json`'da tutulur. 10 dakikada 5 otomatik restart olunca açılır, 10 dakika restart olmayınca kapanır. 20-30 s'de bir çöken süreç start limit'e (120 s'de 8) hiç ulaşmaz ve unit `failed` olmaz. `failed` unit'te bu alarm açılmaz, çünkü `unit:<id>` zaten açıktır. Elle start'ın sıfırladığı `NRestarts` yeni taban sayılır.
  - **Doctor, check'in sonucuna bakar.** `check-state.json` son tamamlanan çalıştırmayı (`lastRunAt`) ve teslimatın sonucunu (`delivery`: ok, hata; URL yok) tutar.
    - `<prefix>-check.service` `failed` ise FAIL.
    - Son tamamlanan check 120 s'den eskiyse FAIL.
    - Hiç check tamamlanmamışsa WARN.
    - Webhook'a 5 dakikadan uzun süredir ulaşamamış bir açılış ya da kapanış varsa FAIL. Son teslimat yalnızca başarısızsa WARN.
    - Gerekçe: timer `active` kalırken her çalıştırma düşebilir ve check kendi arızasını alarm olarak bildiremez.
  - **journald.** Etkin `Storage=` değeri `systemd-analyze cat-config systemd/journald.conf`'taki son `[Journal]` atamasıdır; drop-in'ler dahildir. Komut yoksa `/etc/systemd/journald.conf` okunur. `volatile`/`none` WARN'dır, `/var/log/journal` dizini olsa bile. `auto` ancak dizin varsa OK sayılır. `/var/log/journal/<machine-id>` yoksa "henüz yazmadı" WARN'ı verilir. Ubuntu 24.04'te `Storage=` hiç atanmaz (auto) ve dizin paketle gelir [P].

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