<?php

namespace LicenceApp\Sdk\WordPress;

use LicenceApp\Sdk\Http\HttpClientInterface;
use LicenceApp\Sdk\Http\HttpResponse;
use LicenceApp\Sdk\Http\NetworkException;

/**
 * `wp_remote_request`, so the site's proxy settings, CA bundle and HTTP
 * filters apply to license checks like to every other request it makes.
 */
final class WordPressHttpClient implements HttpClientInterface
{
    /** @var int */
    private $timeout;

    public function __construct(int $timeoutSeconds = 10)
    {
        $this->timeout = $timeoutSeconds;
    }

    public function send(string $method, string $url, array $headers = [], ?string $body = null): HttpResponse
    {
        $args = [
            'method' => $method,
            'headers' => $headers,
            'timeout' => $this->timeout,
            'redirection' => 0,
            'sslverify' => true,
        ];

        if ($body !== null) {
            $args['body'] = $body;
        }

        $response = wp_remote_request($url, $args);

        if (is_wp_error($response)) {
            throw new NetworkException($response->get_error_message());
        }

        return new HttpResponse(
            (int) wp_remote_retrieve_response_code($response),
            (string) wp_remote_retrieve_body($response)
        );
    }
}
