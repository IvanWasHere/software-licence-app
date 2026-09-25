<?php

namespace LicenceApp\Sdk\WordPress;

use LicenceApp\Sdk\Client;
use LicenceApp\Sdk\LicenseSdkException;

/**
 * A "License" screen under Settings: enter a key, see the state, deactivate.
 * Administrators only (`manage_options`), and every change goes through
 * admin-post.php with a nonce.
 */
final class SettingsPage
{
    /** @var Client */
    private $client;

    /** @var string */
    private $slug;

    /** @var string */
    private $title;

    /** @var Updater|null */
    private $updater;

    public function __construct(Client $client, string $slug, string $title, ?Updater $updater = null)
    {
        $this->client = $client;
        $this->slug = $slug;
        $this->title = $title;
        $this->updater = $updater;
    }

    public function register(): void
    {
        add_action('admin_menu', [$this, 'addPage']);
        add_action('admin_post_' . $this->action(), [$this, 'handle']);
    }

    public function addPage(): void
    {
        add_options_page($this->title . ' license', $this->title . ' license', 'manage_options', $this->pageSlug(), [$this, 'render']);
    }

    public function pageUrl(): string
    {
        return admin_url('options-general.php?page=' . $this->pageSlug());
    }

    public function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        $state = $this->client->validate();
        $key = $this->client->licenseKey();
        $notice = isset($_GET['licence_app_notice']) ? sanitize_text_field(wp_unslash($_GET['licence_app_notice'])) : '';

        echo '<div class="wrap"><h1>' . esc_html($this->title . ' license') . '</h1>';

        if ($notice !== '') {
            echo '<div class="notice notice-info"><p>' . esc_html($notice) . '</p></div>';
        }

        echo '<table class="form-table" role="presentation"><tbody>';
        echo '<tr><th scope="row">Status</th><td><strong>' . esc_html(self::describe($state->valid, $state->reason, $state->offline)) . '</strong></td></tr>';

        if ($state->license !== null && isset($state->license['expires_at'])) {
            echo '<tr><th scope="row">Expires</th><td>' . esc_html((string) ($state->license['expires_at'] ?? 'Never')) . '</td></tr>';
        }

        if ($key !== null) {
            echo '<tr><th scope="row">Key</th><td><code>' . esc_html(self::mask($key)) . '</code></td></tr>';
        }

        echo '</tbody></table>';

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="' . esc_attr($this->action()) . '" />';
        wp_nonce_field($this->action());

        if ($key === null) {
            echo '<p><label for="licence-app-key">License key</label><br />';
            echo '<input type="text" class="regular-text code" id="licence-app-key" name="license_key" autocomplete="off" required /></p>';
            echo '<input type="hidden" name="do" value="activate" />';
            submit_button('Activate');
        } else {
            echo '<input type="hidden" name="do" value="deactivate" />';
            submit_button('Deactivate this site', 'secondary');
        }

        echo '</form></div>';
    }

    public function handle(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('You are not allowed to change the license.', '', ['response' => 403]);
        }

        check_admin_referer($this->action());

        $do = isset($_POST['do']) ? sanitize_key(wp_unslash($_POST['do'])) : '';

        if ($do === 'activate') {
            $key = isset($_POST['license_key']) ? sanitize_text_field(wp_unslash($_POST['license_key'])) : '';

            try {
                $state = $this->client->activate($key, ['site_url' => home_url()]);
                $notice = $state->valid ? 'License activated.' : 'Not activated: ' . self::describe(false, $state->reason, false);
            } catch (LicenseSdkException $e) {
                $notice = $e->reason() === LicenseSdkException::NETWORK
                    ? 'The license server could not be reached. Try again in a moment.'
                    : 'That key could not be checked: ' . $e->reason();
            }
        } elseif ($do === 'deactivate') {
            $this->client->deactivate();
            $notice = 'This site is deactivated. Its slot is free.';
        } else {
            $notice = '';
        }

        if ($this->updater !== null) {
            $this->updater->forget();
        }

        wp_safe_redirect(add_query_arg('licence_app_notice', rawurlencode($notice), $this->pageUrl()));
        exit;
    }

    public static function describe(bool $valid, ?string $reason, bool $offline): string
    {
        if ($valid) {
            return $offline ? 'Active (server unreachable — using the last check)' : 'Active';
        }

        $reasons = [
            'no_license_key' => 'No license key entered',
            'invalid_license' => 'That key does not exist',
            'product_mismatch' => 'That key is for a different product',
            'license_revoked' => 'Revoked',
            'license_suspended' => 'Suspended',
            'license_expired' => 'Expired',
            'subscription_inactive' => 'Subscription inactive',
            'not_activated' => 'Not activated on this site',
            'activation_limit_reached' => 'Every site on this license is in use — free one in your account',
            'offline_grace_expired' => 'The license server has been unreachable for too long',
            'untrusted_response' => 'The license server\'s answer could not be verified',
        ];

        return $reasons[(string) $reason] ?? (string) $reason;
    }

    private static function mask(string $key): string
    {
        return strlen($key) > 5 ? str_repeat('•', 8) . substr($key, -5) : $key;
    }

    private function action(): string
    {
        return 'licence_app_' . str_replace('-', '_', $this->slug);
    }

    private function pageSlug(): string
    {
        return $this->slug . '-license';
    }
}
