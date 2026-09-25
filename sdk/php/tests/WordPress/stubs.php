<?php

/**
 * Just enough of WordPress for the adapters to run: options, site
 * transients, filters recorded rather than run, and HTTP routed to the test's
 * fake server.
 */

final class WpStubs
{
    /** @var array<string, mixed> */
    public static $options = [];

    /** @var array<string, mixed> */
    public static $transients = [];

    /** @var array<string, array<int, mixed>> */
    public static $hooks = [];

    /** @var \LicenceApp\Sdk\Http\HttpClientInterface|null */
    public static $http = null;

    public static function reset(): void
    {
        self::$options = [];
        self::$transients = [];
        self::$hooks = [];
        self::$http = null;
    }
}

if (!class_exists('WP_Error')) {
    class WP_Error
    {
        /** @var string */
        public $code;

        /** @var string */
        public $message;

        public function __construct(string $code = '', string $message = '')
        {
            $this->code = $code;
            $this->message = $message;
        }

        public function get_error_code(): string
        {
            return $this->code;
        }

        public function get_error_message(): string
        {
            return $this->message;
        }
    }
}

if (!defined('WP_PLUGIN_DIR')) {
    define('WP_PLUGIN_DIR', '/var/www/wp-content/plugins');
}

function plugin_basename(string $file): string
{
    return ltrim(str_replace(WP_PLUGIN_DIR, '', $file), '/');
}

function add_filter(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    WpStubs::$hooks[$hook][] = $callback;

    return true;
}

function add_action(string $hook, $callback, int $priority = 10, int $args = 1): bool
{
    return add_filter($hook, $callback, $priority, $args);
}

function get_option(string $name, $default = false)
{
    return array_key_exists($name, WpStubs::$options) ? WpStubs::$options[$name] : $default;
}

function update_option(string $name, $value, $autoload = null): bool
{
    WpStubs::$options[$name] = $value;

    return true;
}

function delete_option(string $name): bool
{
    unset(WpStubs::$options[$name]);

    return true;
}

function get_site_transient(string $name)
{
    return WpStubs::$transients[$name] ?? false;
}

function set_site_transient(string $name, $value, int $expiration = 0): bool
{
    WpStubs::$transients[$name] = $value;

    return true;
}

function delete_site_transient(string $name): bool
{
    unset(WpStubs::$transients[$name]);

    return true;
}

function is_wp_error($thing): bool
{
    return $thing instanceof WP_Error;
}

function wp_remote_request(string $url, array $args = [])
{
    try {
        $response = WpStubs::$http->send($args['method'] ?? 'GET', $url, $args['headers'] ?? [], $args['body'] ?? null);
    } catch (\LicenceApp\Sdk\Http\NetworkException $e) {
        return new WP_Error('http_request_failed', $e->getMessage());
    }

    return ['response' => ['code' => $response->status], 'body' => $response->body];
}

function wp_remote_retrieve_response_code($response)
{
    return $response['response']['code'];
}

function wp_remote_retrieve_body($response)
{
    return $response['body'];
}

function download_url(string $url)
{
    $response = wp_remote_request($url);

    if (is_wp_error($response)) {
        return $response;
    }

    $file = tempnam(sys_get_temp_dir(), 'wp-download-');
    file_put_contents($file, $response['body']);

    return $file;
}

function esc_html($text): string
{
    return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8');
}

function wpautop(string $text): string
{
    return '<p>' . str_replace("\n", "<br />\n", $text) . '</p>';
}
