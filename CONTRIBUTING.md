# Katkı

Geliştirme için [Bun](https://bun.sh) 1.4 veya üstü gerekir.

```bash
bun install
bun run typecheck
bun test
```

- Her PR'da typecheck ve testler CI'da çalışır; ikisinin de geçmesi gerekir.
- Davranış değiştiren her değişiklik için test ekle.
- Büyük değişikliklerden önce bir issue açıp yaklaşımı konuşalım.

## Yayın

Sürüm `package.json`'daki `version` alanından gelir. Yayınlamak için:

```bash
npm version patch        # ya da minor / major; commit ve vX.Y.Z tag'i oluşturur
git push --follow-tags
```

Tag push edilince `release` workflow'u testleri çalıştırır, paketi npm'e
provenance ile yayınlar ve Linux/macOS/Windows binary'lerini GitHub Release'e ekler.
