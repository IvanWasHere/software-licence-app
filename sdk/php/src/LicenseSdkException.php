<?php

namespace LicenceApp\Sdk;

/**
 * Thrown only when a question could not be answered at all. A refusal —
 * wrong key, no slots left — is a state with a reason, never an exception.
 */
final class LicenseSdkException extends \RuntimeException
{
    /** The license server could not be reached. */
    public const NETWORK = 'network';

    /** The server answered 422: the request was malformed, e.g. an empty key. */
    public const REJECTED_REQUEST = 'rejected_request';

    /** An answer arrived that is not signed by a pinned key. Check the public key. */
    public const UNTRUSTED_RESPONSE = 'untrusted_response';

    /** @var string */
    private $reason;

    public function __construct(string $message, string $reason)
    {
        parent::__construct($message);
        $this->reason = $reason;
    }

    public function reason(): string
    {
        return $this->reason;
    }
}
