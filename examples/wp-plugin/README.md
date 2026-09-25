# 🧩 Example: a licensed WordPress plugin

`invoice-pro-example` is a small plugin wired to a Licence App server with the
[PHP SDK](../../sdk/php):

- **Settings → Invoice Pro license**: enter a key, see its state, deactivate the site.
- An admin notice while the site has no valid license.
- `[invoice_pro_pdf]`, a premium feature shown only when the license grants `pdf_export`.
- Updates through the normal WordPress Updates screen, served from the releases you publish.

## 📦 Build it

```bash
./build.sh           # → dist/invoice-pro-example-1.0.0.zip
./build.sh 1.1.0     # the same plugin, stamped 1.1.0
```

The zip is one folder with the SDK copied into `lib/`, so the plugin runs without Composer.

## 🧪 Try the whole loop

1. Run the server (`npm run dev`) and seed the demo catalog (`node ace dev:seed`). **Invoice Pro**
   (`invoice-pro`) is the product this plugin is licensed as.
2. Install `dist/invoice-pro-example-1.0.0.zip` on any WordPress site. Point it at your server in
   `wp-config.php`, with the key from `GET /api/v1/keys`:

   ```php
   define('INVOICE_PRO_LICENSE_SERVER', 'http://localhost:3333/api/v1');
   define('INVOICE_PRO_LICENSE_PUBLIC_KEYS', ['k1' => '…public_key…']);
   ```

   Locally, set `LICENSE_SIGNING_KEY` on the server (`node ace licensing:keygen`). Otherwise the
   key changes on every restart and the plugin rightly stops believing it.
3. Enter a key from the customer portal under **Settings → Invoice Pro license**.
4. In the back-office, open **Products → Invoice Pro**, upload `dist/invoice-pro-example-1.1.0.zip`
   as a release and publish it.
5. On the site, **Dashboard → Updates** offers 1.1.0, and *Update now* installs it.

> **A local server on a non-standard port.** WordPress only downloads packages from ports 80, 443
> and 8080, and never from `localhost`. A real license server is neither. For a local test, add a
> must-use plugin to the WordPress site:
>
> ```php
> <?php // wp-content/mu-plugins/allow-local-licence-server.php — local testing only
> add_filter('http_request_host_is_external', '__return_true');
> add_filter('http_allowed_safe_ports', function ($ports) { $ports[] = 3333; return $ports; });
> ```

## ✅ What was checked

This loop was run end to end against a real WordPress 7.1 (SQLite, driven by WP-CLI):

- The plugin activates, and the settings screen renders its state.
- Without a key, 1.1.0 is listed but refused with "Enter your license key…".
- With a key, 1.1.0 installs, verified against its signed checksum.
- With the update window closed, the update is refused with `updates_expired`, and the license
  still validates.
