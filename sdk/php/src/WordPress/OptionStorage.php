<?php

namespace LicenceApp\Sdk\WordPress;

use LicenceApp\Sdk\Storage\StorageInterface;

/**
 * Keeps the client's record in `wp_options`, not autoloaded — it is read on
 * the pages that ask about the license, not on every request.
 */
final class OptionStorage implements StorageInterface
{
    /** @var string */
    private $prefix;

    /**
     * The client's own key is already namespaced (`licence-app:invoice-pro`
     * becomes the option `licence_app_invoice_pro`); a prefix is only needed
     * to keep two installs of the SDK apart on one site.
     */
    public function __construct(string $prefix = '')
    {
        $this->prefix = $prefix;
    }

    public function get(string $key): ?string
    {
        $value = get_option($this->name($key), null);

        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value): void
    {
        update_option($this->name($key), $value, false);
    }

    public function remove(string $key): void
    {
        delete_option($this->name($key));
    }

    private function name(string $key): string
    {
        return $this->prefix . preg_replace('/[^a-z0-9_]+/', '_', strtolower($key));
    }
}
