# Sunucuda barındırma (host)

Temiz bir Ubuntu 24.04 VPS'ten çalışan bir `prod` ve `dev` branch'ine kadar kurulum, sonra günlük işletim. Örnekler sahibin kurulumunu kullanır: domain `incibase.omergenc.net`, branch adresleri `https://<branch>--<project>.incibase.omergenc.net`, Cloudflare proxied wildcard DNS ve Cloudflare Origin CA sertifikası, alarmlar ntfy.sh'a, dashboard ve MCP yalnızca `incibase tunnel` (SSH) ile. Tasarımın ayrıntıları ve gerekçeleri: [m1-mimari.md](m1-mimari.md).

Örneklerde laptoptan sunucuya `ssh vps` ile bağlanılır (`~/.ssh/config`'te bir alias), sunucudaki giriş hesabı `omer`, proje `shop`.

> Host katmanı (`host`, `project`, `branch`, `release`, `env`, `service-key`, `status`, `logs`, `tunnel` komutları) 0.3.1'den sonraki ilk sürümle gelir; [CHANGELOG](../CHANGELOG.md)'da şimdilik "Unreleased" altında. 0.3.1 ve öncesinin binary'lerinde bu komutlar yok. Aşağıda `V=x.y.z` gördüğün yere o sürümü ya da daha yenisini yaz.

## Ne elde edersin

- Tek VPS'te birden fazla proje, her projede `prod`, `dev` ve istersen `preview` branch'leri. Her branch'in kendi süreci, OS kullanıcısı, verisi, anahtarları, release'leri ve adresi var.
- Branch'ler birbirinin verisini, env'ini, soketlerini ve süreçlerini göremez; bellek, CPU, PID ve disk branch başına sınırlı.
- Production release'leri önce snapshot alır, migration'ı verinin bir kopyasında dener (preflight), sonra restart eder ve yeni sürüm sağlıklı görünene kadar bekler (gate). Bir şey ters giderse önceki release'e dönülür.
- Public internette admin gücü yok: dashboard ve admin MCP yalnızca SSH tüneliyle.
- Bir branch takılır ya da çökerse 30 s'de bir koşan check onu yakalar ve telefona bildirim düşer.

```
İnternet ──▶ Cloudflare (TLS, proxied *.incibase.omergenc.net)
               │ :443, Origin CA sertifikası (Full (strict))
               ▼
            nginx (TLS, limit_req/limit_conn, JSON log, admin yolları 404)
               │ Host: <branch>--<project>.incibase.omergenc.net
               │ unix socket: /var/lib/incibase/hosts/<label>/http.sock
               ▼
   incibase-branch@<id>.service   (kullanıcı ib-<id>, incibase.slice, systemd sandbox)
       incibase serve --bundle releases/<seq>/app.ib --socket … --admin-socket …
               ▲
               │ admin.sock (grup incibase-admin)
   laptop: incibase tunnel shop/prod --ssh vps ──ssh -L──▶ /var/lib/incibase/admin/<label>.sock

   kontrol düzlemi: sudo incibase … → SQLite registry (control/registry.db, root 0600) + systemctl
   incibase-check.timer (30 s): health, takılanı öldürme, alarm → ntfy.sh
```

- **Ön kapı** stok nginx. Her branch için ayrı `server` bloğu yok; Host adından label çıkarılır ve istek o branch'in unix soketine gider.
- **Her branch bir systemd unit'i**, kendi kullanıcısıyla (`ib-<id>`) ve sandbox'ında koşar. Unit'leri systemd başlatır ve yeniden başlatır; boot'ta da kalkarlar.
- **Kontrol düzlemi** root olarak çalışan bir CLI'dır. Daemon yok: her komut registry'yi kısa bir kilitle günceller, türetilmiş dosyaları (unit drop-in'leri, env dosyaları, nginx config'i) yazar ve systemctl çağırır.
- **Admin yüzeyi** (dashboard, admin API, admin MCP) public adreste yok; branch onu ayrı bir `admin.sock`'ta sunar. O sokete yalnızca `incibase-admin` grubundaki giriş hesapları SSH tüneliyle ulaşır.

## Gereksinimler

- **VPS:** Ubuntu 24.04, KVM (container VPS değil: OpenVZ/LXC'de sandbox direktiflerinin bir kısmı çalışmaz), en az 4 GB RAM. Varsayılan branch belleği prod 512M, dev 256M; bütün branch'ler birlikte RAM − 1G ile sınırlı (`incibase.slice`).
- **sudo yetkili bir giriş hesabı**, SSH anahtarıyla:
  ```bash
  # sunucuda, root olarak
  adduser omer
  usermod -aG sudo omer
  # laptopta
  ssh-copy-id omer@<vps-ip>
  ```
  Bundle'ı ya da sırları stdin'den göndermek için (`ssh vps sudo incibase … - < dosya`) sudo'nun parola sormaması gerekir: stdin yönlendirilmişken ssh sudo'ya parola soracak bir terminal vermez. İstersen yalnızca incibase'e parolasız sudo ver (`sudo visudo -f /etc/sudoers.d/incibase`):
  ```
  omer ALL=(root) NOPASSWD: /usr/local/bin/incibase
  ```
  incibase root olarak her şeyi yapabildiğinden bu satır pratikte bu hesaba root verir; hesabın SSH anahtarını buna göre koru. İstemezsen dosyayı `scp` ile gönderip `ssh -t` ile çalıştırırsın (aşağıda iki biçim de var).
- **Paketler:** `sudo apt install nginx openssl curl ufw`. nginx'i incibase kurmaz, yalnızca config'ini yazar. ufw çoğu VPS imajında hazırdır ama minimal imajlarda yoktur.
- **DNS:** Cloudflare'de yönetilen bir zone (aşağıda).

## Cloudflare

Zone `omergenc.net` Cloudflare'de olduğu varsayılır.

1. **DNS kaydı.** DNS > Records:
   - `A` kaydı, ad `*.incibase`, değer VPS'in IPv4 adresi, **Proxied** (turuncu bulut).
   - VPS'in IPv6'sı varsa aynı adla bir `AAAA` kaydı, o da Proxied.
   - `incibase.omergenc.net`'in kendisi (apex) için kayıt gerekmez: nginx yalnızca `<branch>--<project>.incibase.omergenc.net` adlarını kabul eder, çıplak domain'e ve bilinmeyen adlara TLS el sıkışmasını reddeder (`ssl_reject_handshake`).
2. **Kenar sertifikası.** `prod--shop.incibase.omergenc.net`, `omergenc.net`'in **ikinci seviye** alt alanıdır. Cloudflare'in ücretsiz Universal SSL sertifikası yalnızca apex'i ve birinci seviyeyi (`*.omergenc.net`) kapsar; ikinci seviye adlar için tarayıcı sertifika hatası görür. Şunlardan biri gerekir:
   - Advanced Certificate Manager ile `*.incibase.omergenc.net` için bir advanced sertifika, ya da aynı paketteki **Total TLS** (proxied her ad için otomatik sertifika),
   - ya da `*.incibase.omergenc.net`'i kapsayan yüklenmiş bir custom sertifika.

   SSL/TLS > Edge Certificates'ta `*.incibase.omergenc.net`'i kapsayan bir sertifikanın **Active** olduğunu gör.
3. **Şifreleme modu.** SSL/TLS > Overview: **Full (strict)**. Cloudflare origin'in sertifikasını doğrular; Origin CA sertifikası bu modda geçerlidir.
4. **Origin CA sertifikası.** SSL/TLS > Origin Server > Create Certificate:
   - "Generate private key and CSR with Cloudflare", anahtar türü RSA ya da ECC.
   - Hostnames: `*.incibase.omergenc.net` (istersen `incibase.omergenc.net` de).
   - Geçerlilik: istediğin süre (en çok 15 yıl).
   - Biçim PEM. "Origin Certificate"i `origin.pem`, "Private Key"i `origin.key` olarak kaydet. **Private key yalnızca bu ekranda gösterilir.**

   İkisini sunucuya kopyala ve yalnızca root okuyabilsin:
   ```bash
   scp origin.pem origin.key vps:
   ssh -t vps 'sudo install -d -m 0700 /root/origin && sudo install -m 0600 origin.pem origin.key /root/origin/ && rm origin.pem origin.key'
   ```
   `host init` (ya da sonra `host tls`) çifti doğrular (`*.incibase.omergenc.net`'i kapsıyor mu, anahtar eşleşiyor mu, süresi geçerli mi) ve `/var/lib/incibase/tls/` altına (root 0700) kopyalar; nginx o kopyayı sunar. `/root/origin` altındaki dosyalar sonra silinebilir. Laptoptaki kopyayı da sil ya da bir parola yöneticisinde sakla.
5. **HTTP'yi kenarda HTTPS'e çevir.** SSL/TLS > Edge Certificates: **Always Use HTTPS** açık. Böylece `http://` istekleri origin'e hiç gelmeden Cloudflare'de `https://`'e yönlendirilir.
6. **İstemci adresi.** Cloudflare proxied olduğundan nginx'e gelen bağlantı Cloudflare'in adresinden gelir. `--trust-proxy cloudflare` ile nginx istemci adresini `CF-Connecting-IP`'den alır, ama **yalnızca** bağlantı Cloudflare'in IP aralıklarından geliyorsa (aralıklar incibase'in içinde sabit; yeni sürümlerle güncellenir). Başka yerden gelen bir `CF-Connecting-IP`'ye inanılmaz. Rate limit'ler (`limit_req`, `limit_conn`) ve branch'in gördüğü `X-Forwarded-For` bu adrese göre çalışır.

Cloudflare'in ücretsiz ve Pro planlarında istek gövdesi en çok 100 MB'tır; incibase'in varsayılan yükleme sınırı da 100 MB.

## Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**Firewall zorunlu.** Branch unit'leri `SocketBindDeny=any` taşır: branch kodu TCP portu açamasın diye. Ama Ubuntu 24.04'ün systemd paketi BPF framework'süz derlenmiş (`systemctl --version` çıktısında `-BPF_FRAMEWORK`) ve SocketBindDeny buna muhtaç; bu sürümde **uygulanmaz**. Kötü niyetli ya da hatalı bir branch 0.0.0.0'da bir port açabilir. Yerel ve özel ağdaki eşleri (diğer branch'ler, nginx) `IPAddressDeny` dışarıda tutar; internete karşı geriye kalan tek engel host firewall'udur. `host doctor` bunu her çalıştırmada WARN olarak hatırlatır. 22, 80 ve 443 dışında her portu kapalı tut. Sağlayıcının firewall'u (cloud firewall, security group) yalnızca 22/80/443'e izin veriyorsa aynı işi görür; ikisi birlikte de olur.

incibase'in ön kapısı yalnızca 443'te (`--https-port`) dinler; 80'i Cloudflare'in "Always Use HTTPS" yönlendirmesi (yukarıdaki 5. adım) kenarda karşılar. Ubuntu'nun nginx paketi ise `sites-enabled/default`'u açık getirir: origin'in 80'inde "Welcome to nginx!" sayfası nginx sürümüyle birlikte cevap verir. incibase o siteyi kullanmaz; kaldır:

```bash
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

80'e origin'de hiç ihtiyacın yoksa `sudo ufw allow 80/tcp` satırını da atlayabilirsin. Daha sıkı istersen 443'ü yalnızca Cloudflare'in IP aralıklarına aç; böylece origin Cloudflare'i atlayarak doğrudan çağrılamaz.

## incibase'i kurmak

Sıra: binary'yi GitHub release'inden indir ve `SHA256SUMS` ile doğrula, onunla `host init` çalıştır, sonra kendisini runtime olarak kur ve `/usr/local/bin/incibase`'i ona bağla. İndirilen dosyayı ancak en sonda sil. Üç blok aynı kabukta koşar (`$V` ve `$ARCH` ilk bloktan gelir).

### 1. İndirmek ve doğrulamak

```bash
V=x.y.z                                    # host katmanını içeren sürüm (yukarıdaki not)
ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
cd ~
curl -fsSLO https://github.com/omer-genc/incibase/releases/download/v$V/incibase-linux-$ARCH
curl -fsSLO https://github.com/omer-genc/incibase/releases/download/v$V/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS     # incibase-linux-<arch>: OK
chmod +x incibase-linux-$ARCH
```

### 2. `host init`

`host init` dışındaki her komut kurulmuş bir host ister (`No incibase host at /var/lib/incibase: run sudo incibase host init …`), o yüzden ilk komut budur ve indirilen dosyayla çalışır. `sudo` bulunduğun dizini korur, ama binary o dizindeki `bunfig.toml`'u ve `.env`'i okumaz; ev dizinindeki bir dosya root olarak çalışan komuta bir şey yükleyemez. `host install-runtime` kurduğu binary'ye sürümünü `/`'te sorar, böylece cwd'yi hâlâ okuyan eski bir sürüm (0.3.1) kurulurken de ev dizininden bir şey yüklemez.

```bash
sudo ./incibase-linux-$ARCH host init \
  --domain incibase.omergenc.net \
  --timezone Europe/Istanbul \
  --tls-cert /root/origin/origin.pem \
  --tls-key /root/origin/origin.key \
  --trust-proxy cloudflare
```

```
/var/lib/incibase is set up for incibase.omergenc.net
  units incibase-*, groups incibase-admin and incibase-proxy
  front door: certificate installed, nginx restart
  check timer: waits for /usr/local/bin/incibase (host use-cli), skipping every run until then
Next: sudo /home/omer/incibase-linux-x64 host install-runtime /home/omer/incibase-linux-x64 --version x.y.z --sums SHA256SUMS, then sudo /home/omer/incibase-linux-x64 host use-cli x.y.z
```

Ne yapar: registry (`/var/lib/incibase/control/registry.db`), `incibase-proxy` (www-data üyesi) ve `incibase-admin` grupları, `incibase.slice`, branch/preflight/snapshot unit şablonları, `incibase-check.timer`, nginx config'i (`/etc/nginx/conf.d/incibase.conf`) ve nginx drop-in'i (`OOMScoreAdjust=-900`). Tekrar çalıştırmak güvenlidir.

- `--timezone` branch'lerin cron'ları için `TZ` olur.
- `--https-port` (varsayılan 443), `--slice-memory` (varsayılan RAM − 1G), `--uid-base` (varsayılan 70000; yalnızca ilk branch'ten önce), `--tunnel-port-base` (varsayılan 7101) genelde değişmez.
- `--no-check-timer` yalnızca testler için; üretimde timer açık kalmalı.
- `Next:` satırı bir sonraki adımı yazar. CLI link'i (`/usr/local/bin/incibase`) henüz kurulu bir runtime'a gitmiyorsa bu, aşağıdaki 3. adımdır (`install-runtime`, sonra `use-cli`); gidiyorsa `host add-admin` ve `project create`; host'ta zaten proje varsa `Next:` satırı yoktur. Varsayılan olmayan bir `--root` (ya da `$INCIBASE_HOST_ROOT`; sudo onu düşürür) ile `Next:`'teki her komut `--root <dizin>` taşır; layout root'un registry'sinden okunduğundan `--layout` gerekmez.
- Sertifikayı sonra yenilemek: `sudo incibase host tls --cert <pem> --key <key>` (`nginx -t` ile denenir, geçerse nginx reload). `trust_proxy` ve `https_port` sonradan `host set` ile değişir.
- **Bir makinede bir host.** `--root` (ya da `$INCIBASE_HOST_ROOT`) yalnızca veri dizinini değiştirir; unit adları (`incibase-*`), gruplar, `/etc/nginx/conf.d/incibase.conf`, nginx drop-in'i, `/usr/local/lib/incibase` ve `/usr/local/bin/incibase` aynı kalır. Bu dosyalar hangi host'a ait olduklarını yazar (unit'lerde ve nginx dosyalarında `# host root: /var/lib/incibase` satırı, runtime kökünde `.incibase-host`). Aynı makinede başka bir `--root` ile ikinci bir `host init` hiçbir şey yazmadan reddedilir (`This machine already has the incibase host at /var/lib/incibase: …`) ve çakışan dosyaları listeler; ilk host'un check unit'i CLI link'ini daha `use-cli`'dan önce adlandırdığından bu, link henüz yokken de geçerlidir. Aynı root'ta `host init`'i tekrar çalıştırmak ve `host render` etkilenmez. Üretim makinesinde tek host kur; denemeleri ayrı bir VM'de yap. Eski host'u kaldırdıysan, hata mesajının listelediği dosyaları sildikten sonra yeni root'la `host init` geçer.

### 3. Runtime ve CLI

```bash
sudo ./incibase-linux-$ARCH host install-runtime ./incibase-linux-$ARCH --version $V --sums SHA256SUMS
sudo ./incibase-linux-$ARCH host use-cli $V
rm incibase-linux-$ARCH SHA256SUMS
incibase --version
sudo incibase host runtimes
```

- `host install-runtime` binary'yi `SHA256SUMS`'taki girdisiyle (ya da `--sha256 <hex>` ile) karşılaştırır; eşleşmezse siler ve hiç çalıştırmaz. Eşleşirse `/usr/local/lib/incibase/<sürüm>/incibase` olarak kurar ve registry'ye yazar. Checksum'sız kurulum yok.
- Yerel dosya vermezsen `host install-runtime --version $V` binary'yi ve `SHA256SUMS`'ı GitHub release'inden kendisi indirip doğrular (yükseltmelerde bunu kullanırsın).
- Kurulu bir sürümü tekrar kurmak hiçbir şeyi değiştirmez. Dosyaları (binary, sürüm dizini, runtime root) yalnızca root'un değilse onları yeniden root'un yapar (`Already installed, its files made root's alone again`): önce dizinleri, sonra binary'nin root'a ait bir kopyasını hash'leyip kayıtlı sha256'yla aynıysa onu yerine koyarak. Aynı değilse kayıtlı baytları yeniden kurar. Bu yüzden böyle bir runtime için elle `chown` yapılmaz: dosyayı yazabilen biri baytları değiştirmiş olabilir, `chown` onları root'un yapardı.
- `host use-cli` `/usr/local/bin/incibase`'i kurulu runtime'a symlink yapar. Oraya elle kopyalanmış bir dosya varsa yalnızca `--replace` ile yerine geçer. Root bu link'in gösterdiğini çalıştırdığından `use-cli` şunları CONFLICT ile reddeder: link'in dizini ya da `/`'e kadar üstündeki herhangi bir dizin root'un değilse ya da başkası yazabiliyorsa (Ubuntu'da `/usr/local/bin` `root:root 0755`'tir; değilse `chown root:root` ve `chmod go-w` ile düzelt), runtime'ın dosyaları ya da runtime root'tan `/`'e kadar herhangi bir dizin yalnızca root'un değilse, binary'nin baytları kurulurken kaydedilen sha256 değilse, ya da link başka bir host'unsa. Herkesin yazabildiği bir dizin sticky olsa da (`/tmp`) kabul edilmez: check unit'i link'i hep adlandırır, root'un oradaki dizini gidince (yeniden başlatma `/tmp`'yi temizler) herkes onu yeniden yaratabilir. `host init` link'in dizinini aynı şekilde denetler; henüz olmayan bir dizini (özel bir layout) yalnızca root yaratabiliyorsa kabul eder, `Next:` satırı da önce `sudo install -d -m 0755 <dizin>` yazar.
- **Check timer CLI link'ini bekler.** `incibase-check.service` `/usr/local/bin/incibase host check …` çalıştırır: link'in kendisini, indirilen dosyayı değil (o dosyayı giriş hesabı değiştirebilir, root ise onu her 30 s'de çalıştırırdı). `host init`'ten `use-cli`'a kadar link yoktur; systemd her çalıştırmayı `ConditionFileIsExecutable` ile atlar (hata değil), `host doctor` da bu arada `FAIL cli link` ve `FAIL check timer` verir. `use-cli`'dan sonraki ilk tetiklemede check çalışır; `host render` gerekmez. İleride `use-cli` ile CLI'ı başka bir sürüme geçirmek check'i de geçirir ve `host gc` link'in gösterdiği runtime'ı silmez.
- Her branch bir runtime sürümüne **pinlenir** (varsayılan: branch'i oluşturan CLI'ın sürümü); CLI'ı yükseltmek branch'leri değiştirmez.

## `host doctor`

```bash
sudo incibase host doctor
```

Host'un dayandığı her şeyi OK/WARN/FAIL olarak listeler; bir FAIL varsa 1 ile çıkar. Temiz bir Ubuntu 24.04 KVM'de beklenen WARN'lar:

| Satır | Anlamı |
|---|---|
| `WARN sandbox SocketBindDeny: unsupported by this systemd build (-BPF_FRAMEWORK) …` | Yukarıdaki firewall notu. Kalıcıdır; firewall kapalı portlarla bunu karşılar. |
| `WARN alerts: no alert_webhook …` | Henüz alarm adresi yok; [Alarmlar](#alarmlar-ntfysh) bölümünde düzelir. |
| `WARN check timer: …` (hiç check tamamlanmadı) | `host use-cli`'dan hemen sonra; ilk check 30 s içinde koşunca OK olur. |
| `WARN sshd: sshd is not installed …` | Yalnızca SSH sunucusu olmayan bir makinede; VPS'te çıkmaz. |

Başka bir WARN ya da herhangi bir FAIL bir şeyin yanlış olduğunu söyler; satırın kendisi ne yapılacağını yazar. `use-cli`'dan önce çalıştırırsan `FAIL cli link: /usr/local/bin/incibase does not exist: …` ve `FAIL check timer: every run of incibase-check.service is skipped …` görürsün; [3. adım](#3-runtime-ve-cli) düzeltir. `/usr/local/bin/incibase` kurulu bir runtime'a giden bir symlink değilse (ör. elle kopyalanmış bir dosya) `cli link` de FAIL'dir: `host use-cli <sürüm> --replace`. Link'in dizini ya da runtime root'un üstündeki bir dizin root'tan başkasınca değiştirilebiliyorsa satır `use-cli` yerine gereken `chown`/`chmod`'u yazar; sticky ya da herkesin yazabildiği bir dizin için `chmod` değil, başka bir dizinde CLI link ya da runtime root önerir. Runtime'ın kendi dosyaları yalnızca root'un değilse (link yokken de) `chown` değil `host install-runtime --version <sürüm>` önerir (yukarıya bak). Link'in runtime'ı root'un olsa da baytları kayıtlı sha256 değilse (ör. biri yazabildiği sırada değiştirip sonra elle `chown`'lanmışsa) `cli link` FAIL'dir ve aynı komutu önerir. Bir container'da (`WARN virtualization: a container (lxc) …`) ProtectProc ve ProtectSystem WARN olur; aynı direktifler bir VM'de çalışmazsa FAIL'dir ([Sorun giderme](#sorun-giderme)).

`host status` aynı makinenin özetidir: domain, ön kapı, check timer, runtime'lar, branch sayıları ve açık alarmlar.

## Admin hesabı ve SSH

```bash
sudo incibase host add-admin omer
```

`omer`'i `incibase-admin` grubuna ekler; bu grup her branch'in admin soketine ulaşır, yani `incibase tunnel`'ı açar. Yalnızca giriş hesapları (uid 1000–59999) eklenebilir. Grup bir sonraki SSH girişinde geçerli olur: oturumu kapatıp yeniden bağlan.

Tünel bir unix sokete `ssh -L` yönlendirmesi kullanır; sshd buna izin vermeli. Ubuntu'nun varsayılanı izin verir (`AllowStreamLocalForwarding yes`); sertleştirilmiş bir config'te açıkça yaz:

```bash
echo 'AllowStreamLocalForwarding local' | sudo tee /etc/ssh/sshd_config.d/50-incibase.conf
sudo sshd -t && sudo systemctl reload ssh
```

`DisableForwarding yes` tüneli kapatır. `host doctor`'ın `sshd` satırı ikisini de denetler.

## Proje: prod ve dev

```bash
sudo incibase project create shop
```

```
Created project shop:
  shop/prod                prod    https://prod--shop.incibase.omergenc.net
  shop/dev                 dev     https://dev--shop.incibase.omergenc.net
```

- `--branches` varsayılan olarak `prod,dev`; `--name` bir görünen ad.
- `prod` korumalıdır (protected): durdurmak, silmek, snapshot geri yüklemek ve korumayı kaldırmak hostname'iyle onay ister (`--confirm prod--shop.incibase.omergenc.net`). `dev` korumasızdır.
- Release olmadan branch başlamaz; `branch list` `stopped`, `inactive/dead` gösterir.
- Sonradan başka bir branch: `sudo incibase branch create shop/feature-x` (adı `prod`/`dev` değilse türü `preview`). Label (`<branch>--<project>`) en çok 63 karakter; `www`, `api`, `admin`, `deploy` gibi adlar ayrılmış.
- Limitler: `sudo incibase branch set shop/prod --memory 768M --restart` (MemoryHigh %90'da kalır). Diğerleri `--cpu`, `--tasks`, `--max-db`, `--max-storage`, `--max-upload`, `--timeouts`, `--drain-timeout`, `--preflight on|off`; `--restart` olmadan değişiklik bir sonraki başlatmada geçerli olur. `branch info shop/prod` hepsini gösterir.

## Release

Laptopta, uygulamanın reposunda bundle'ı oluştur. Bundle uygulamayı npm bağımlılıklarıyla birlikte tek bir `app.ib` dosyasına koyar; VPS'te derleme ya da `bun install` yok. `incibase bundle` uygulamanın üst düzey kodunu bir kez çalıştırır.

```bash
bunx incibase bundle --out app.ib
```

Sonra kopyala ve release et (parola soran sudo ile):

```bash
scp app.ib vps: && ssh -t vps sudo incibase release add shop/dev app.ib
```

ya da stdin'den, kopyalamadan (parolasız sudo gerekir):

```bash
ssh vps sudo incibase release add shop/prod - < app.ib
```

Prod'da çıktı şuna benzer:

```
release shop/prod#2: snapshot /var/lib/incibase/backups/<id>/pre-2.db
release shop/prod#2: preflight (serve --migrate-only on a copy of the data)
release shop/prod#2: preflight passed in 285 ms
release shop/prod#2: starting generation 2.fbae109782c2
release shop/prod#2: healthy after 1327 ms
release shop/prod#2 is live
```

- Root bundle'ın yalnızca manifest satırını okur ve sha256'sını kontrol eder; uygulama kodunu hiçbir zaman root olarak çalıştırmaz.
- Release `systemd-run` ile ayrı bir transient unit'te koşar: SSH koparsa iş devam eder. Yarıda kalan bir işi `sudo incibase host render` tamamlar ya da geri alır.
- **Prod:** snapshot → preflight (migration verinin bir kopyasında, branch'in kullanıcısı ve bellek sınırıyla) → restart → gate (yeni generation'ın sağlıklı görülmesi). Preflight 64, 65, 78 ya da OOM ile düşerse canlı branch'e hiç dokunulmaz.
- **Dev ve preview:** snapshot ve preflight yok (tam DB kopyası pahalı); `--preflight` ile istenebilir, `branch set … --preflight on` ile kalıcı olur. Prod'da `--no-preflight` atlar.
- Migration değeri olan bir alanı silecekse reddedilir; bilerek silmek için `--allow-field-removal`.
- Gate düşerse ve migration commit edilmediyse önceki release'e otomatik dönülür. Migration commit edildiyse release yerinde kalır, alarm açılır ve [rollback --restore](#rollback-ve-snapshotlar) önerilir.
- `release list shop/prod`: release'ler, en yenisi üstte; `*` çalışan.

## Env ve sırlar

Uygulamanın env değişkenleri branch başına registry'de tutulur ve branch'in env dosyasına (`control/env/<id>.env`, root 0600) yazılır. `env set|unset|import` bir sonraki başlatmada geçerli olur; hemen istersen `--restart` (gate ile).

**Sırlar için stdin'den `env import`.** Komut satırındaki bir değer sudo'nun loguna (auth.log, journal) ve her hesabın gördüğü `ps` çıktısına düşer:

```bash
# laptopta, prod.env: KEY=VALUE satırları (boş satır ve # yorum atlanır, değerler tırnaklı olabilir)
ssh vps sudo incibase env import shop/prod - --restart < prod.env
```

Parolalı sudo ile: `scp prod.env vps: && ssh -t vps 'sudo incibase env import shop/prod prod.env --restart; rc=$?; rm -f prod.env; exit $rc'` (dosya import ya da restart düşse de silinir).

- Gizli olmayan tek değerler: `sudo incibase env set shop/dev FEATURE_X=1 --restart`; silmek: `env unset shop/dev FEATURE_X`.
- `env list shop/prod` adları ve kimin koyduğunu (`host`/`app`) gösterir; değerler yalnızca `--show` ile.
- Değerler satır sonu içeremez; çok satırlı değerleri (PEM anahtarları) base64 ile ver.
- `INCIBASE_*`, `BUN_*`, `NODE_*`, `LD_*`, `SYSTEMD_*`, `TZ`, `PATH` gibi adları host koyar; `env set` onları değiştiremez. `INCIBASE_ADMIN_KEY`, `INCIBASE_STORAGE_SECRET`, `INCIBASE_BRANCH_*`, `INCIBASE_S3_PREFIX` ve `TZ` her branch'te hazırdır.
- S3: bir branch başka bir branch'in `S3_ACCESS_KEY_ID`'sini ancak `--shared-s3-credentials` ile alır. Prefix bir sınır değildir; branch başına kimlik bilgisi (ya da bucket) kullan.
- `env import`, `env list` ve `release add` çalışan release'in kullandığı (manifest'teki) ama branch'te eksik olan env adları için uyarır.

## Servis anahtarları

Başka bir sunucunun (ör. faturalama servisin) bir branch'in internal fonksiyonlarını çağırması için. Hosted branch'lerde admin anahtarı public adreste 401 alır; onun yerine servis anahtarı kullanılır.

```bash
ssh -t vps sudo incibase service-key create shop/prod --label billing
```

- Stdout'a yalnızca anahtar (`ik_svc_<id>_<secret>`) yazılır, **bir kez**; registry yalnızca sha256'sını tutar. Doğrudan bir sır yöneticisine ya da servisin env'ine koy.
- `--scopes`: `internal` (varsayılan; internal fonksiyonlar), `impersonate` (`x-incibase-as-user` ile bir kullanıcı adına), `upload` (imzalı URL olmadan yükleme). Gerekeni ver.
- Anahtar yalnızca o branch'te geçer; dev'in anahtarı prod'da geçmez.
- `service-key list shop/prod` (anahtarlar değil, id/etiket/kapsam), `service-key revoke shop/prod <id>`: branch anahtarlarını restart olmadan hemen yeniden okur.

Servisinde:

```ts
const shop = new IncibaseClient("https://prod--shop.incibase.omergenc.net", { token: process.env.SHOP_SERVICE_KEY });
```

Fonksiyon kodunda servis çağrısı `ctx.auth.service` (`{ keyId, scopes }`) olarak görünür; `ctx.auth.isAdmin` false'tur. Ayrıntılar: [baska-projede-kullanim.md](baska-projede-kullanim.md).

## Frontend: dev ve prod

Frontend hangi branch'e bağlanacağını yalnızca adresle seçer:

```ts
const client = new IncibaseClient(import.meta.env.VITE_INCIBASE_URL);
```

```bash
# .env.development
VITE_INCIBASE_URL=https://dev--shop.incibase.omergenc.net
# .env.production
VITE_INCIBASE_URL=https://prod--shop.incibase.omergenc.net
```

- İstemci oturum token'ını `incibase:token:<baseUrl>` anahtarında saklar: aynı tarayıcıda dev'e ve prod'a giriş birbirini ezmez, dev'in token'ı prod'a gönderilmez. Kullanıcılar ve oturumlar branch başınadır; dev'deki hesap prod'da yoktur.
- Restart sırasında nginx `503` + `x-incibase-unprocessed: 1` döner; istemci bu yanıtları ~15 s boyunca jitter'la tekrar dener, WebSocket yeniden bağlanıp yeniden abone olur. Deploy'lar kullanıcıya genelde kısa bir bekleme olarak görünür.
- Hosted branch'lerde CORS `*`'tır (`INCIBASE_*` adları host'a ait olduğundan `INCIBASE_CORS_ORIGINS` `env set` ile verilemez). Cookie'ye dayalı kimlik doğrulama kullanma: bütün branch'ler `incibase.omergenc.net` altında olduğundan bir branch diğerlerinin cookie'lerini ayarlayabilir; incibase'in kendisi bearer token kullanır.

## Dashboard ve MCP: `incibase tunnel`

Laptopta (root gerekmez; incibase CLI'ı laptopta da olmalı, ör. uygulamanın reposunda `bunx incibase`):

```bash
bunx incibase tunnel shop/prod --ssh vps --open
```

```
shop/prod is reachable at http://127.0.0.1:7101
  Dashboard  http://127.0.0.1:7101/_/
  MCP        claude mcp add --transport http incibase-prod--shop http://127.0.0.1:7101/mcp --header "Authorization: Bearer $(ssh … vps sudo incibase admin-key shop/prod)"
  Admin key  ssh … vps sudo incibase admin-key shop/prod
Ctrl-C closes the tunnel.
```

- Tünel `127.0.0.1:<port>`'u branch'in admin soketine yönlendirir. Her branch'in kendi portu var (7101'den başlar), dolayısıyla kendi origin'i ve dashboard'da kendi kayıtlı girişi.
- Dashboard admin anahtarını ister. Anahtarı ayrı bir terminalde al: `ssh -t vps sudo incibase admin-key shop/prod` (stdout'a yalnızca anahtar yazılır). Anahtarı değiştirmek: `sudo incibase admin-key shop/prod --rotate` (branch restart olur, admin oturumları biter).
- MCP aynı tünelde `/mcp`'dedir; tünel açıkken Claude Code'a `claude mcp add` ile eklenir. Tünel kapalıyken MCP sunucusuna ulaşılamaz.
- Tünelin yazdığı tek satırlık `claude mcp add … $(ssh … vps sudo incibase admin-key shop/prod)` **parolasız sudo** ister ([Gereksinimler](#gereksinimler)'deki sudoers satırı): `-t` olmadan sudo parola soramaz, `-t` ile de alınan anahtarın sonuna terminalin `\r`'si eklenir. Parolalı sudo ile anahtarı `ssh -t vps sudo incibase admin-key shop/prod` ile al ve elle yapıştır:
  ```bash
  claude mcp add --transport http incibase-prod--shop http://127.0.0.1:7101/mcp --header "Authorization: Bearer <admin anahtarı>"
  ```
  Her iki biçimde de anahtar `claude` sürecinin argümanlarında görünür ve Claude Code'un MCP config'inde düz metin olarak saklanır; o dosyayı bir sır gibi koru. `admin-key --rotate`'ten sonra eski başlık geçersizdir: `claude mcp remove incibase-prod--shop` ile kaldırıp yeni anahtarla yeniden ekle.
- `--local-port`, `--timeout`, `--ssh-config <dosya>` (ssh -F), `--root <dizin>` (sunucudaki host root'u, varsayılan `/var/lib/incibase`) ve `--json` da var. `--ssh` ssh'in kabul ettiği her hedefi alır (`omer@<ip>` ya da config alias'ı).
- Tünel açılmıyorsa: hesap admin grubunda mı (`host add-admin`, sonra yeniden giriş), sshd yönlendirmeye izin veriyor mu, branch çalışıyor mu (`incibase status`).

## Durum, loglar, alarmlar

```bash
sudo incibase status              # her branch: istenen ve gerçek durum, release, generation, bellek, URL; altta açık alarmlar
sudo incibase status shop         # yalnızca bir proje (ya da shop/prod)
sudo incibase branch info shop/prod
sudo incibase host status
```

```bash
sudo incibase logs shop/prod -f
sudo incibase logs shop/prod --errors --since "1 hour ago"
sudo incibase logs shop/prod --lines 200
sudo incibase logs shop/prod --json --since today
```

Loglar journal'dan gelir; branch'ler satır başına bir JSON nesnesi yazar (istek kimliği `rid`, uygulamanın `console.*` çıktısı dahil). Anahtarlar ve token'lar log'a yazılmaz. Tenant'ın yazdığı kontrol karakterleri terminale ulaşmadan `?` olur.

### Check timer

`incibase-check.timer` her 30 s'de `host check`'i çalıştırır (elle de çalıştırılabilir: `sudo incibase host check`):

- Her çalışan branch'in admin soketinde `/api/health`. Dinleyip cevap vermeyen ya da 200 dışı dönen bir branch üç ardışık denemeden sonra SIGKILL'lenir ve systemd onu yeniden başlatır. Henüz dinlemeyen (başlıyor, uzun migration) bir branch öldürülmez; 120 s'den uzun sürerse "başlangıç uzun sürüyor" alarmı açılır.
- `failed` bir unit (çıkış 1, 137 ya da OOM) arıza başına bir kez, 10 dakika sonra yeniden denenir. 64, 65 ve 78 denenmez.
- Disk: dosya sistemi %80 ve %90 dolulukta alarm (3 puan aşağı inince kapanır).
- Alarm anahtarları: `health:<id>`, `startup:<id>`, `unit:<id>`, `restarts:<id>` (10 dakikada 5 otomatik restart), `disk:80`, `disk:90`.

Servis CLI link'ini (`/usr/local/bin/incibase`) çalıştırır; link kurulu bir runtime'a gidene kadar ([3. adım](#3-runtime-ve-cli)) her çalıştırma atlanır.

`host doctor` check'in kendisini de denetler: timer'ın servisi `failed` ise, son tamamlanan check 120 s'den eskiyse, CLI link'i yok olduğu için her çalıştırma atlanıyorsa ya da diskteki check unit'i bu incibase'in yazdığı değilse (`host render` yeniden yazar) FAIL.

### Alarmlar (ntfy.sh)

1. Tahmin edilemeyen bir topic adı seç; ntfy.sh'ta topic adı tek erişim kontrolüdür: `openssl rand -hex 16`.
2. Telefondaki ntfy uygulamasında o topic'e abone ol.
3. Sunucuda, URL'yi stdin'den ver (`-`): komutu çalıştır, `https://ntfy.sh/<topic>` yaz, Enter, sonra Ctrl-D:
   ```bash
   sudo incibase host set alert_webhook - --test
   ```
   Laptoptan, bir dosyadan (parolasız sudo gerekir): `ssh vps sudo incibase host set alert_webhook - --test < ntfy-url.txt`.

- Stdin'den tek satır okunur (boş satırlar ve baştaki/sondaki boşluklar atlanır, en çok 4096 bayt); boş stdin reddedilir. Yalnızca https kabul edilir; kullanıcı/parola ya da `#` içeren URL'ler reddedilir. `--test` bir deneme bildirimi gönderir.
- Topic adı bir sırdır; `-` onu komut satırının dışında tutar. URL'yi doğrudan argüman olarak vermek (`host set alert_webhook https://ntfy.sh/<topic>`) de çalışır ama topic'i sudo'nun loguna (auth.log, journal) ve o an `ps` çıktısına düşürür. Öyle verdiysen ya da topic başka bir yolla sızdıysa yeni bir topic seçip `host set alert_webhook -` ile değiştir. Audit satırında URL değil yalnızca host tutulur.
- Bir alarm açılınca ve kapanınca birer bildirim gider. Mesajlardan anahtarlar, app env değerleri ve webhook URL'sinin kendisi çıkarılır.
- Teslimat başarısızsa bir sonraki check'te tekrar denenir; 5 dakikadan uzun süredir ulaşılamıyorsa `host doctor` FAIL verir.
- Kaldırmak: `sudo incibase host set alert_webhook ''`.

## Rollback ve snapshot'lar

```bash
sudo incibase release rollback shop/prod                 # bir önceki iyi release'e, veriye dokunmadan
sudo incibase release rollback shop/prod --to 3          # belirli bir release'e
sudo incibase release rollback shop/prod --restore --confirm prod--shop.incibase.omergenc.net
sudo incibase release rollback shop/prod --snapshot pre-5 --confirm prod--shop.incibase.omergenc.net
```

- Düz rollback yalnızca kodu değiştirir. Yeni sürümün migration'ı veriyi zaten dönüştürdüyse eski kod onu açmayı reddeder (65); o durumda `--restore` gerekir.
- `--restore`, mevcut release'ten önce alınan snapshot'ı (`pre-<mevcut seq>`) geri koyar ve önceki release'e döner: **snapshot'tan sonra yazılan her şey kaybolur**. `--snapshot pre-N` başka bir snapshot seçer. Geri yükleme korunan branch'te onay ister.
- Değiştirilen veritabanı silinmez: `backups/<id>/replaced-<zaman>/` altında kalır (son 2'si).

**Ne tutulur:**

| Ne | Nerede | Kaç tane |
|---|---|---|
| Release dosyaları | `branches/<id>/releases/<seq>/app.ib` | son 5 başarılı release (çalışan her zaman) |
| Snapshot'lar (yalnızca prod; her release'ten ve runtime yükseltmesinden önce) | `backups/<id>/pre-<seq>.db`, `pre-upgrade-<n>.db` | branch başına son 3 |
| Geri yüklemede değiştirilen veritabanı | `backups/<id>/replaced-<zaman>/` | son 2 |
| Silinen prod branch'lerinin verisi | `trash/` | 7 gün |

Bunlar aynı diskte durur; off-site yedek değildir (planlı ve off-site yedekler M3'te). Şimdilik önemli veriyi kendin dışarı kopyala.

## Silmek

```bash
sudo incibase branch delete shop/dev
sudo incibase branch delete shop/prod --confirm prod--shop.incibase.omergenc.net
sudo incibase project delete shop
```

- Branch silmek unit'lerini, kullanıcısını ve dosyalarını kaldırır. Production branch'i korunmasa bile onay ister; verisi `trash/`'e taşınır ve 7 gün durur (`Deleted shop/prod; its data stays in /var/lib/incibase/trash for 7 days`). Dev ve preview branch'lerinin verisi hemen silinir.
- `project delete` yalnızca branch'i kalmamış projeyi siler; production verisi tek komutla, onaysız gitmesin diye.
- `sudo incibase host gc` 7 günden eski trash'i ve hiçbir branch'in kullanmadığı runtime'ları siler. `--older-than <gün>` süreyi değiştirir (`--older-than 0` hepsini).
- Branch'i silmeden durdurmak: `sudo incibase branch stop shop/prod --confirm prod--shop.incibase.omergenc.net` (reboot'larda da durur); geri açmak `branch start`.

## incibase'i yükseltmek

```bash
V=x.y.z
sudo incibase host install-runtime --version $V     # GitHub'dan indirir, SHA256SUMS ile doğrular
sudo incibase host use-cli $V                       # /usr/local/bin/incibase artık $V
sudo incibase host render                           # unit'ler ve nginx config'i yeni sürümle yeniden yazılır
sudo incibase host doctor
sudo incibase branch upgrade shop/dev --runtime $V
sudo incibase branch upgrade shop/prod --runtime $V
sudo incibase host runtimes                         # hangi branch hangi sürüme pinli (PINNED BY)
sudo incibase host gc                               # artık kullanılmayan runtime'lar
```

- `shop/feature-x` gibi preview branch'leri ve başka projelerin branch'leri de eski sürüme pinli kalır; `host gc` o sürümü onlar yüzünden silmez. `sudo incibase branch list`'in RUNTIME sütununa ya da `host runtimes`'ın PINNED BY sütununa bak ve her birini `branch upgrade <project>/<branch> --runtime $V` ile yükselt.
- `branch upgrade` prod'da snapshot (`pre-upgrade-<n>`) ve preflight alır, restart eder ve gate'i bekler; düşerse pin eski sürüme geri döner. Önce dev'i yükseltip denemek iyi bir alışkanlık.
- Kurulu bir sürüm başka baytlarla asla değiştirilmez; aynı sürümü yeniden kurmak bir şey yapmaz.
- Laptoptaki incibase'i (bundle ve tunnel için) uygulamanın reposunda ayrıca yükselt; bundle'ı branch'in runtime'ıyla aynı sürümle oluşturmak en güvenlisi.

## Sorun giderme

### Çıkış kodları

Branch süreci (`incibase serve`) şu kodlarla çıkar; systemd unit'i `Restart=on-failure`, `RestartSec=2`, `StartLimitBurst=8` / `StartLimitIntervalSec=120` ve `RestartPreventExitStatus=64 65 78` taşır:

| Kod | Anlamı | systemd ne yapar |
|---|---|---|
| 0 | Normal çıkış (drain bitti) | Restart yok |
| 1 | Çökme ya da uygulama modülünün hatası | 2 s sonra restart; 120 s'de 8 denemeyi aşınca `failed`, check 10 dk sonra bir kez yeniden dener |
| 64 | Config hatası: eksik sır, meta'da sır, bind izni, binary'den yeni DB şeması | Restart yok, `failed` |
| 65 | Migration reddi (ör. değeri olan alanı silmek) | Restart yok, `failed` |
| 75 | Geçici: data dir kilitli, port/soket meşgul | Restart edilir |
| 78 | Uygulama tanım hatası (bozuk şema, bilinmeyen cron hedefi, tekrarlanan route); veritabanına hiçbir şey yazılmaz | Restart yok, `failed` |

Prod'da preflight 64/65/78'i canlıya gitmeden yakalar. Sahip CLI'ının kendi kodları farklıdır: 0 tamam, 1 başarısız ya da reddedildi (gate düşmesi, doctor FAIL dahil), 2 kullanım hatası.

### Başlamayan bir branch

```bash
sudo incibase status shop
sudo incibase logs shop/prod --since "15 min ago"
sudo incibase branch info shop/prod        # kullanıcı ib-<id>, unit adı için id
systemctl status incibase-branch@<id>.service
```

- `ACTUAL` `failed` ve log'da `exit 64/65/78`: düzeltmeden restart işe yaramaz. 64 için eksik env'i ekle (`env import`), 65/78 için uygulamayı düzeltip yeni release ver ya da `release rollback`. Sonra `sudo incibase branch start shop/prod`.
- `has no release to run`: henüz `release add` yapılmadı.
- Release `failed` ama önceki release çalışıyor: gate düşmüş ve geri dönülmüş; `release list` hatayı, `logs` ayrıntıyı gösterir.
- SSH kopması ya da makinenin yeniden başlaması sırasında yarım kalan bir iş branch'i "busy" bırakmışsa: `sudo incibase host render`.

### Restart sırasında 503

Branch restart olurken (release, `--restart`, crash) nginx soketine bağlanamaz ve `503` döner, `x-incibase-unprocessed: 1` ve `Retry-After: 1` ile, gövde `{"error":{"code":"BRANCH_UNAVAILABLE"}}`. İstek branch'e hiç ulaşmamıştır; istemci güvenle tekrar dener. Birkaç saniyeden uzun sürüyorsa branch ayakta değildir: `incibase status`.

- `502` (unprocessed işareti olmadan): branch bağlantıyı kabul edip cevap vermeden kapattı; istek işlenmiş olabilir, istemci tekrar denemez.
- Aynı `503` durdurulmuş (`branch stop`) ya da henüz release'i olmayan bir branch'ten de, süresiz gelir: mesaj "restarting" dese de branch kalkmayacaktır. `incibase status`'ta `stopped` görürsün; `branch start` ya da `release add` ile düzelir.
- `404` JSON: o label'da branch yok (adı kontrol et).
- Cloudflare `526`: origin sertifikası geçersiz (Full (strict) Origin CA çiftini göremiyor). `525`: el sıkışması başarısız; ad nginx'in kabul ettiği biçimde mi (`<branch>--<project>.incibase.omergenc.net`), `--https-port` 443 mü.
- Tarayıcıda sertifika hatası, Cloudflare'in kenar sertifikası: yukarıdaki ikinci seviye alt alan notu.

### Disk doluyor

`disk:80`/`disk:90` alarmı gelir; `host doctor` %90'da WARN, %95'te FAIL verir. Dolu diskte branch'ler `SQLITE_FULL` alır.

```bash
df -h /var/lib/incibase
sudo du -h -d 1 /var/lib/incibase/branches /var/lib/incibase/backups /var/lib/incibase/trash
sudo incibase host gc --older-than 0     # trash ve kullanılmayan runtime'lar
sudo journalctl --vacuum-size=500M
```

- Eski release dosyaları ve snapshot'lar kendiliğinden budanır (son 5 / son 3); `backups/<id>/replaced-*` geri yüklemelerden kalır.
- Bir branch'i sınırlamak: `branch set … --max-db 2G --max-storage 10G`. Not: `--max-db`'yi mevcut veritabanının yarısından aşağı indirmek o branch'in prod release'lerini snapshot aşamasında durdurur.
- Prod release'i 2 × DB + 100 MB boş alan yoksa snapshot'a hiç başlamaz.

### Container'larda (OrbStack, LXC) sandbox

Host katmanı bir LXC container'ında da çalışır (testler OrbStack'teki Ubuntu 24.04'te koşar), ama orada `/run/systemd/system/service.d/zzz-lxc-service.conf` her servis için ProtectSystem, ProtectHome, PrivateDevices, NoNewPrivileges ve ProtectProc'u kapatır. `host doctor` bunları container'da WARN, VM'de FAIL olarak raporlar. Üretim için KVM bir VM kullan; container'da branch'ler arasındaki uid, dosya izni, soket ve `IPAddressDeny` ayrımı yine geçerlidir ama bir branch kök dosya sistemine (izinlerin elverdiği yerlere) yazabilir ve diğer süreçleri `/proc`'ta görebilir.
