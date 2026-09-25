<?php

namespace LicenceApp\Sdk\WordPress;

use LicenceApp\Sdk\Client;
use LicenceApp\Sdk\UpdateCheck;

/**
 * Serves a plugin's updates from the license server, through WordPress's own
 * update screens (licence plan §7.2).
 *
 * - `pre_set_site_transient_update_plugins` — tells WordPress a newer version
 *   exists. The answer is cached for `cache_hours`, so a busy admin does not
 *   ask the server on every page.
 * - `plugins_api` — the "View details" popup: changelog and requirements.
 * - `upgrader_pre_download` — the moment the update is installed. A download
 *   link only lives ten minutes and the update screen may have been open for
 *   hours, so a fresh one is fetched here, and the file is checked against
 *   the SHA-256 in the signed answer before WordPress unpacks it.
 *
 * A license that does not cover the new version still sees it, with a note
 * saying why, and no package: WordPress shows "automatic update is
 * unavailable". The plugin itself keeps working.
 */
final class Updater
{
    private const UNAVAILABLE = 'unavailable';

    /** @var Client */
    private $client;

    /** @var string e.g. `invoice-pro/invoice-pro.php` */
    private $basename;

    /** @var string e.g. `invoice-pro` */
    private $slug;

    /** @var string */
    private $version;

    /** @var string */
    private $name;

    /** @var string */
    private $channel;

    /** @var int */
    private $cacheSeconds;

    /** @var string|null */
    private $homepage;

    /**
     * @param array{
     *   plugin_file: string,
     *   version: string,
     *   name?: string,
     *   channel?: string,
     *   cache_hours?: int,
     *   homepage?: string
     * } $options
     */
    public function __construct(Client $client, array $options)
    {
        $this->client = $client;
        $this->basename = plugin_basename($options['plugin_file']);
        $this->slug = dirname($this->basename) !== '.' ? dirname($this->basename) : basename($this->basename, '.php');
        $this->version = $options['version'];
        $this->name = $options['name'] ?? $this->slug;
        $this->channel = $options['channel'] ?? 'stable';
        $this->cacheSeconds = (int) (($options['cache_hours'] ?? 12) * 3600);
        $this->homepage = $options['homepage'] ?? null;
    }

    public function register(): void
    {
        add_filter('pre_set_site_transient_update_plugins', [$this, 'injectUpdate']);
        add_filter('plugins_api', [$this, 'pluginInfo'], 10, 3);
        add_filter('upgrader_pre_download', [$this, 'preDownload'], 10, 4);
        add_action('upgrader_process_complete', [$this, 'forget'], 10, 0);
    }

    /**
     * @param mixed $transient
     * @return mixed
     */
    public function injectUpdate($transient)
    {
        if (!is_object($transient)) {
            return $transient;
        }

        $check = $this->check();

        if ($check === null || $check->release === null) {
            return $transient;
        }

        $item = $this->item($check);

        if ($check->isNewerThan($this->version)) {
            $transient->response[$this->basename] = $item;
            unset($transient->no_update[$this->basename]);
        } else {
            $transient->no_update[$this->basename] = $item;
            unset($transient->response[$this->basename]);
        }

        return $transient;
    }

    /**
     * @param mixed $result
     * @param mixed $args
     * @return mixed
     */
    public function pluginInfo($result, string $action = '', $args = null)
    {
        if ($action !== 'plugin_information' || !is_object($args) || ($args->slug ?? null) !== $this->slug) {
            return $result;
        }

        $check = $this->check();

        if ($check === null || $check->release === null) {
            return $result;
        }

        $release = $check->release;
        $changelog = (string) ($release['changelog'] ?? '');

        return (object) [
            'name' => $this->name,
            'slug' => $this->slug,
            'version' => $release['version'],
            'homepage' => $this->homepage,
            'requires' => $release['requires']['wp'] ?? null,
            'requires_php' => $release['requires']['php'] ?? null,
            'tested' => $release['tested_up_to'] ?? null,
            'last_updated' => $release['published_at'] ?? null,
            'download_link' => $check->updateAllowed ? $check->downloadUrl : '',
            'sections' => [
                'changelog' => $changelog !== '' ? wpautop(esc_html($changelog)) : '<p>No changelog.</p>',
            ] + ($check->updateAllowed ? [] : ['license' => '<p>' . esc_html($this->explain($check)) . '</p>']),
        ];
    }

    /**
     * Download our package ourselves: with a fresh link, and verified against
     * the signed checksum. Any other package is left to WordPress.
     *
     * @param mixed $reply
     * @param mixed $package
     * @param mixed $upgrader
     * @param mixed $hookExtra
     * @return mixed
     */
    public function preDownload($reply, $package, $upgrader = null, $hookExtra = [])
    {
        if ($reply !== false || !is_array($hookExtra) || ($hookExtra['plugin'] ?? null) !== $this->basename) {
            return $reply;
        }

        $check = $this->client->latestRelease($this->channel);

        if ($check === null || !$check->updateAllowed || $check->downloadUrl === null) {
            return new \WP_Error(
                'licence_app_no_package',
                $check !== null ? $this->explain($check) : 'The license server could not be reached. Try again later.'
            );
        }

        $file = download_url($check->downloadUrl);

        if (is_wp_error($file)) {
            return $file;
        }

        $expected = strtolower((string) $check->checksum());

        if ($expected === '' || !hash_equals($expected, (string) hash_file('sha256', $file))) {
            @unlink($file);

            return new \WP_Error(
                'licence_app_checksum_mismatch',
                'The downloaded update does not match its signed checksum, so it was not installed.'
            );
        }

        return $file;
    }

    /** Drop the cached answer, e.g. after an update or a new key. */
    public function forget(): void
    {
        delete_site_transient($this->cacheKey());
    }

    private function check(): ?UpdateCheck
    {
        $cached = get_site_transient($this->cacheKey());

        if ($cached === self::UNAVAILABLE) {
            return null;
        }

        if (is_array($cached)) {
            return UpdateCheck::fromArray($cached);
        }

        $check = $this->client->latestRelease($this->channel);

        /**
         * Kept as a plain array, never a serialized object. A failed check is
         * cached for an hour, not twelve: the server being down should not
         * hide an update for half a day.
         */
        if ($check === null) {
            set_site_transient($this->cacheKey(), self::UNAVAILABLE, 3600);
        } else {
            set_site_transient($this->cacheKey(), $check->toArray(), $this->cacheSeconds);
        }

        return $check;
    }

    private function item(UpdateCheck $check): object
    {
        $release = (array) $check->release;

        $item = (object) [
            'id' => $this->basename,
            'slug' => $this->slug,
            'plugin' => $this->basename,
            'new_version' => $release['version'],
            'url' => $this->homepage,
            'package' => $check->updateAllowed ? $check->downloadUrl : '',
            'requires' => $release['requires']['wp'] ?? null,
            'requires_php' => $release['requires']['php'] ?? null,
            'tested' => $release['tested_up_to'] ?? null,
        ];

        if (!$check->updateAllowed) {
            $item->upgrade_notice = $this->explain($check);
        }

        return $item;
    }

    private function explain(UpdateCheck $check): string
    {
        switch ($check->reason) {
            case 'updates_expired':
                return 'Your license\'s update period has ended. Renew it to install this version; the version you have keeps working.';
            case 'license_required':
            case 'no_license_key':
                return 'Enter your license key to install updates.';
            case 'not_activated':
                return 'This site is not activated. Re-enter your license key.';
            case 'license_expired':
            case 'subscription_inactive':
                return 'Your license has expired. Renew it to install updates.';
            default:
                return 'Your license does not include this update (' . (string) $check->reason . ').';
        }
    }

    private function cacheKey(): string
    {
        return 'licence_app_update_' . md5($this->basename);
    }
}
