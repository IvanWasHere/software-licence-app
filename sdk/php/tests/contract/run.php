<?php

/**
 * Driven by the server's suite (tests/functional/sdk/php_sdk.spec.ts): the
 * real PHP client against the real server, over HTTP. Reads its settings as
 * JSON on argv[1], prints what happened as JSON.
 *
 * Uses the Composer-less autoloader, so it also proves a plugin can ship the
 * SDK without Composer.
 */

require __DIR__ . '/../../src/autoload.php';

use LicenceApp\Sdk\Client;
use LicenceApp\Sdk\LicenseSdkException;
use LicenceApp\Sdk\Storage\FileStorage;

$config = json_decode($argv[1], true);
$client = new Client([
    'base_url' => $config['base_url'],
    'product' => $config['product'],
    'public_key' => $config['public_key'],
    'storage' => new FileStorage($config['storage']),
    'client_version' => '1.0.0-php-contract',
]);

$out = [];

try {
    foreach ($config['steps'] as $step) {
        switch ($step) {
            case 'activate':
                $out[$step] = $client->activate($config['key'], ['site_url' => 'https://wp.example.com'])->toArray();
                break;
            case 'validate':
                $out[$step] = $client->validate(true)->toArray();
                break;
            case 'has':
                $out[$step] = $client->has($config['entitlement']);
                break;
            case 'latest':
                $check = $client->latestRelease($config['channel'] ?? 'stable');
                $out[$step] = $check ? $check->toArray() : null;

                if ($check !== null && $check->downloadUrl !== null) {
                    $handle = curl_init($check->downloadUrl);
                    curl_setopt_array($handle, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3]);
                    $bytes = curl_exec($handle);
                    $out['download'] = [
                        'status' => curl_getinfo($handle, CURLINFO_RESPONSE_CODE),
                        'sha256' => is_string($bytes) ? hash('sha256', $bytes) : null,
                        'matches_signed_checksum' => is_string($bytes) && hash_equals((string) $check->checksum(), hash('sha256', $bytes)),
                    ];
                }
                break;
            case 'deactivate':
                $out[$step] = $client->deactivate();
                break;
        }
    }
} catch (LicenseSdkException $e) {
    $out['error'] = $e->reason();
}

echo json_encode($out);
