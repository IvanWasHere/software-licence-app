<?php

namespace LicenceApp\Sdk\Http;

final class HttpResponse
{
    /** @var int */
    public $status;

    /** @var string */
    public $body;

    public function __construct(int $status, string $body)
    {
        $this->status = $status;
        $this->body = $body;
    }
}
