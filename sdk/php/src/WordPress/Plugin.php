<?php

namespace LicenceApp\Sdk\WordPress;

use LicenceApp\Sdk\Client;

/**
 * Everything a licensed plugin needs, in one call from its main file:
 *
 *     $license = \LicenceApp\Sdk\WordPress\Plugin::boot([
 *         'plugin_file' => __FILE__,
 *         'version'     => '1.2.0',
 *         'name'        => 'Invoice Pro',
 *         'base_url'    => 'https://licenses.example.com/api/v1',
 *         'product'     => 'invoice-pro',
 *         'public_key'  => ['k1' => '…'],
 *     ]);
 *
 *     if ($license->validate()->valid) { … }
 *
 * It wires the client to wp_options and wp_remote_request, registers the
 * updater and adds the settings screen.
 */
final class Plugin
{
    /**
     * @param array<string, mixed> $options the Client's options (base_url,
     *   product, public_key, …) plus plugin_file, version, and optionally
     *   name, channel, cache_hours, homepage, settings_page (default true)
     */
    public static function boot(array $options): Client
    {
        $client = new Client([
            'base_url' => $options['base_url'],
            'product' => $options['product'],
            'public_key' => $options['public_key'],
            'storage' => $options['storage'] ?? new OptionStorage(),
            'http' => $options['http'] ?? new WordPressHttpClient(),
            'client_version' => $options['version'],
        ]);

        $updater = new Updater($client, [
            'plugin_file' => $options['plugin_file'],
            'version' => $options['version'],
            'name' => $options['name'] ?? $options['product'],
            'channel' => $options['channel'] ?? 'stable',
            'cache_hours' => $options['cache_hours'] ?? 12,
            'homepage' => $options['homepage'] ?? null,
        ]);
        $updater->register();

        if ($options['settings_page'] ?? true) {
            (new SettingsPage($client, $options['product'], $options['name'] ?? $options['product'], $updater))->register();
        }

        return $client;
    }
}
