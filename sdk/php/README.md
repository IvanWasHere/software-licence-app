# 🐘 licence-app/sdk

License checks and plugin updates for PHP software and WordPress plugins, against a
[Licence App](../../README.md) server. It is the PHP twin of [`@licence-app/sdk`](../js), and
follows the same rules.

- 🪶 **No dependencies.** PHP 7.4+ with `sodium`, which PHP has bundled since 7.2. It works with
  Composer, or copied into a plugin folder without it.
- 🔏 **Believes only signed answers.** Every answer must verify against a key you pin, and must echo
  this request's nonce, product and installation. The cache is re-verified every time it is read.
- 📴 **Keeps working offline.** When the server can't be reached, the last good answer stands for
  the product's offline grace period.
- 🔄 **Updates through WordPress itself.** New versions show up on the normal Updates screen.
  - A fresh download link is fetched at install time.
  - The zip is checked against the **signed SHA-256** before WordPress unpacks it.
- 🧘 **Never switches anything off by itself.** It reports a state; your plugin decides what to
  lock.

```bash
composer require licence-app/sdk
```

## 🚀 WordPress in one call

In your plugin's main file:

```php
require __DIR__ . '/vendor/autoload.php';          // or: lib/licence-app-sdk/src/autoload.php

function my_plugin_license(): \LicenceApp\Sdk\Client
{
    static $client = null;

    return $client ??= \LicenceApp\Sdk\WordPress\Plugin::boot([
        'plugin_file' => __FILE__,
        'version'     => '1.2.0',                  // this build's version
        'name'        => 'Invoice Pro',
        'base_url'    => 'https://licenses.example.com/api/v1',
        'product'     => 'invoice-pro',
        // From GET /api/v1/keys → data[0]. Pin it in your build; never fetch it at runtime.
        'public_key'  => ['k1' => 'p8Yx…32-byte-key-base64url'],
    ]);
}

my_plugin_license(); // boots the updater and the settings screen

if (my_plugin_license()->validate()->valid && my_plugin_license()->has('pdf_export')) {
    // premium feature
}
```

Keep the client in a function, not a global variable. WordPress includes a plugin's file inside a
function when it activates it, and WP-CLI always does, so a top-level variable there is not global.
(`??=` needs PHP 7.4; that is also the SDK's minimum.)

`Plugin::boot` wires:

| | |
|---|---|
| 🗄️ Storage | One `wp_options` row (`licence_app_{product}`), not autoloaded |
| 🌐 HTTP | `wp_remote_request`, so the site's proxy and CA settings apply |
| 🔄 `Updater` | `pre_set_site_transient_update_plugins`, `plugins_api` ("View details"), `upgrader_pre_download` |
| ⚙️ `SettingsPage` | Settings → *{Name} license*: enter a key, see the state, deactivate. `manage_options` and a nonce on every change. Pass `'settings_page' => false` to build your own |

### 🔄 How updates behave

| Situation | What WordPress shows |
|---|---|
| Licensed, newer version published | The usual "update available"; *Update now* installs it |
| Update window ended (`updates_until` before the release) | The new version, no package, and "Your license's update period has ended…". **The installed version keeps working** |
| No key entered | The new version, and "Enter your license key to install updates" |
| Server unreachable | Nothing changes. It asks again within the hour |

The answer is cached for 12 hours (`cache_hours`). The *download* link is fetched fresh the moment
the update installs, because a link only lives ten minutes and the Updates screen may have been
open all afternoon. A zip whose SHA-256 doesn't match the signed checksum is refused.

Ship a release: zip the plugin folder, upload it in the back-office (**Products → your product →
Upload a release**), then publish. [`examples/wp-plugin`](../../examples/wp-plugin) has a build
script that does the zipping.

## 🧩 Without WordPress

```php
use LicenceApp\Sdk\Client;
use LicenceApp\Sdk\Storage\FileStorage;

$license = new Client([
    'base_url'   => 'https://licenses.example.com/api/v1',
    'product'    => 'invoice-pro',
    'public_key' => ['k1' => '…'],
    'storage'    => new FileStorage(getenv('HOME') . '/.invoice-pro/license.json'), // mode 0600
    // 'http'    => new \LicenceApp\Sdk\Http\CurlHttpClient(10),                      // the default
]);

$license->activate('WIPRO-7K4DX-82M91-QP6F3-A0ZT9', ['site_url' => 'https://shop.example.com']);

$state = $license->validate();          // LicenseState: valid, reason, source, offline, entitlements…
$license->has('pdf_export');            // bool
$license->get('max_clients', 50);       // the value, or the fallback
$check = $license->latestRelease();     // UpdateCheck|null: release, updateAllowed, reason, downloadUrl
$license->deactivate();                 // frees the slot, forgets the key
```

## 🧠 How it decides

Exactly as the JS SDK:

| Situation | What `validate()` returns |
|---|---|
| A verified answer younger than the product's `validation_interval_hours` | That answer, `source: 'cache'`; no request |
| Older, or `validate(true)` | A fresh answer, `source: 'network'` |
| Server unreachable, a 5xx or 429, or an answer that doesn't verify | The last **valid** answer, `offline: true`, while it is younger than `offline_grace_days`; then `offline_grace_expired` |
| A "no" from the server | Reused for an hour (`invalid_cache_minutes`) |
| No key entered yet | `no_license_key`, without asking anybody |

**Reasons** from the server are permanent: `invalid_license`, `product_mismatch`,
`license_revoked`, `license_suspended`, `license_expired`, `subscription_inactive`,
`not_activated` and `activation_limit_reached`. The SDK adds `no_license_key`,
`offline_grace_expired` and `untrusted_response`. An update check can also say `updates_expired`
or `license_required`.

**Exceptions:** only `activate()` throws a `LicenseSdkException`, with `reason()` set to
`network`, `untrusted_response` (check the pinned key) or `rejected_request` (a 422).

## 🧪 Development

```bash
composer install
composer test     # PHPUnit: the client against a signing fake server, the updater against WordPress stubs
composer lint     # php -l on every file
```

The server's own suite runs this client against the real API (`tests/functional/sdk/php_sdk.spec.ts`),
including a real download checked against its signed checksum, so the two can't drift apart. CI
runs the SDK on PHP 7.4, 8.1 and 8.4.
