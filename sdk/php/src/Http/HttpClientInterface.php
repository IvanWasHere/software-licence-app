<?php

namespace LicenceApp\Sdk\Http;

interface HttpClientInterface
{
    /**
     * @param array<string, string> $headers
     * @throws NetworkException when no answer arrived at all
     */
    public function send(string $method, string $url, array $headers = [], ?string $body = null): HttpResponse;
}
