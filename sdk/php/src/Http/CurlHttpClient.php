<?php

namespace LicenceApp\Sdk\Http;

/**
 * cURL, for PHP outside WordPress. Certificates are always verified.
 */
final class CurlHttpClient implements HttpClientInterface
{
    /** @var int */
    private $timeout;

    public function __construct(int $timeoutSeconds = 10)
    {
        $this->timeout = $timeoutSeconds;
    }

    public function send(string $method, string $url, array $headers = [], ?string $body = null): HttpResponse
    {
        $handle = curl_init($url);

        if ($handle === false) {
            throw new NetworkException('Could not start a cURL request');
        }

        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }

        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => min(5, $this->timeout),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ]);

        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }

        $response = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        if (PHP_VERSION_ID < 80000) {
            curl_close($handle); // a no-op since PHP 8, deprecated in 8.5
        }

        if ($response === false || $status === 0) {
            throw new NetworkException($error !== '' ? $error : 'No response');
        }

        return new HttpResponse($status, (string) $response);
    }
}
