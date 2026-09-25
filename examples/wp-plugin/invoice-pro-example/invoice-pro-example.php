<?php
/**
 * Plugin Name:       Invoice Pro (Licence App example)
 * Description:       A licensed plugin wired to a Licence App server: license screen under Settings, updates through the WordPress updater, a premium feature behind an entitlement.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Licence App
 * Text Domain:       invoice-pro-example
 */

if (!defined('ABSPATH')) {
    exit;
}

/*
 * The SDK ships inside the plugin (build.sh copies it to lib/). While
 * developing inside this repository, the source next door is used instead.
 */
$invoice_pro_sdk = is_file(__DIR__ . '/lib/licence-app-sdk/src/autoload.php')
    ? __DIR__ . '/lib/licence-app-sdk/src/autoload.php'
    : __DIR__ . '/../../../sdk/php/src/autoload.php';

require_once $invoice_pro_sdk;

/*
 * Your server and your key. The key comes from GET /api/v1/keys once, at build
 * time — never fetched at runtime. Overridable in wp-config.php for local
 * testing against your own server.
 */
defined('INVOICE_PRO_LICENSE_SERVER') || define('INVOICE_PRO_LICENSE_SERVER', 'https://licenses.example.com/api/v1');
defined('INVOICE_PRO_LICENSE_PUBLIC_KEYS') || define('INVOICE_PRO_LICENSE_PUBLIC_KEYS', ['k1' => 'REPLACE-WITH-YOUR-PUBLIC-KEY']);

/**
 * The plugin's license client, booted once. A function-static rather than a
 * global: WordPress includes a plugin's file inside a function when it is
 * activated (and WP-CLI always does), so a top-level variable is not global.
 *
 * The license decides what is offered, never whether the site works: with no
 * valid license the free part keeps running and the premium part is hidden.
 */
function invoice_pro_license(): \LicenceApp\Sdk\Client
{
    static $client = null;

    if ($client === null) {
        $client = \LicenceApp\Sdk\WordPress\Plugin::boot([
            'plugin_file' => __FILE__,
            'version'     => '1.0.0',
            'name'        => 'Invoice Pro',
            'base_url'    => INVOICE_PRO_LICENSE_SERVER,
            'product'     => 'invoice-pro',
            'public_key'  => INVOICE_PRO_LICENSE_PUBLIC_KEYS,
        ]);
    }

    return $client;
}

// Boot now, so the updater and the settings screen are registered.
invoice_pro_license();

add_action('admin_notices', static function (): void {
    if (!current_user_can('manage_options')) {
        return;
    }

    $state = invoice_pro_license()->validate();

    if ($state->valid) {
        return;
    }

    printf(
        '<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
        esc_html('Invoice Pro: ' . \LicenceApp\Sdk\WordPress\SettingsPage::describe(false, $state->reason, $state->offline) . '.'),
        esc_url(admin_url('options-general.php?page=invoice-pro-license')),
        esc_html('Enter your license key')
    );
});

/*
 * A premium feature, behind an entitlement: [invoice_pro_pdf] renders a
 * button only when the license grants `pdf_export`.
 */
add_shortcode('invoice_pro_pdf', static function (): string {
    $license = invoice_pro_license();
    $license->validate();

    if (!$license->has('pdf_export')) {
        return '<p><em>PDF export is part of Invoice Pro.</em></p>';
    }

    return '<p><button type="button">Download PDF</button></p>';
});
