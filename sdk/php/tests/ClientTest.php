<?php

namespace LicenceApp\Sdk\Tests;

use LicenceApp\Sdk\Client;
use LicenceApp\Sdk\LicenseSdkException;
use LicenceApp\Sdk\LicenseState;
use LicenceApp\Sdk\Storage\FileStorage;
use LicenceApp\Sdk\Storage\MemoryStorage;
use PHPUnit\Framework\TestCase;

/**
 * The client's contract, case for case with the JS SDK's suite.
 */
final class ClientTest extends TestCase
{
    private const DAY = 24 * FakeServer::HOUR;

    /**
     * @param array<string, mixed> $extra
     */
    private function client(FakeServer $server, array $extra = []): Client
    {
        return new Client($extra + [
            'base_url' => 'https://licenses.test/api/v1/',
            'product' => 'invoice-pro',
            'public_key' => $server->publicKey,
            'storage' => new MemoryStorage(),
            'http' => $server,
            'now' => $server->clock(),
        ]);
    }

    public function testWithNoKeyItSaysSoWithoutAskingAnybody(): void
    {
        $server = new FakeServer();
        $state = $this->client($server)->validate();

        $this->assertFalse($state->valid);
        $this->assertSame('no_license_key', $state->reason);
        $this->assertCount(0, $server->calls);
    }

    public function testActivatesRemembersTheKeyAndReadsEntitlements(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server, ['client_version' => '2.4.1']);

        $state = $sdk->activate('  ' . FakeServer::KEY . '  ', ['site_url' => 'https://shop.example.com']);

        $this->assertTrue($state->valid);
        $this->assertSame('network', $state->source);
        $this->assertSame(FakeServer::KEY, $server->calls[0]['body']['license_key'], 'trimmed');
        $this->assertSame('2.4.1', $server->calls[0]['body']['client_version']);
        $this->assertSame('https://shop.example.com', $server->calls[0]['body']['site_url']);
        $this->assertSame('https://licenses.test/api/v1/licenses/activate', $server->calls[0]['url'], 'trailing slash dropped');

        $this->assertTrue($sdk->has('pdf_export'));
        $this->assertFalse($sdk->has('white_label'));
        $this->assertSame(500, $sdk->get('max_clients', 0));
        $this->assertSame('fallback', $sdk->get('missing', 'fallback'));
        $this->assertSame(FakeServer::KEY, $sdk->licenseKey());
    }

    public function testARefusedActivationIsAStateAndTheKeyIsNotRemembered(): void
    {
        $server = new FakeServer(0);
        $sdk = $this->client($server);

        $state = $sdk->activate(FakeServer::KEY);

        $this->assertFalse($state->valid);
        $this->assertSame('activation_limit_reached', $state->reason);
        $this->assertSame('no_license_key', $sdk->validate()->reason);
    }

    public function testAFreshAnswerIsReusedAndAStaleOneIsAskedAgain(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->now += 23 * FakeServer::HOUR;
        $this->assertSame('cache', $sdk->validate()->source);
        $this->assertCount(1, $server->calls, 'no call inside the interval');

        $server->now += 2 * FakeServer::HOUR;
        $this->assertSame('network', $sdk->validate()->source);
        $this->assertCount(2, $server->calls);
    }

    public function testForceSkipsTheCache(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $this->assertSame('network', $sdk->validate(true)->source);
    }

    public function testANoIsReusedForAnHourThenAskedAgain(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->valid = false;
        $server->reason = 'license_suspended';
        $this->assertSame('license_suspended', $sdk->validate(true)->reason);

        $server->valid = true;
        $server->now += 30 * 60000;
        $this->assertSame('license_suspended', $sdk->validate()->reason, 'still the cached no');

        $server->now += 31 * 60000;
        $this->assertTrue($sdk->validate()->valid, 'asked again, and fixed');
    }

    public function testOfflineTheLastGoodAnswerStandsForTheGracePeriodThenItDoesNot(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->down = true;
        $server->now += 3 * self::DAY;

        $inside = $sdk->validate();
        $this->assertTrue($inside->valid);
        $this->assertTrue($inside->offline);
        $this->assertSame('offline', $inside->source);
        $this->assertTrue($sdk->has('pdf_export'), 'entitlements survive offline');

        $server->now += 5 * self::DAY;

        $outside = $sdk->validate();
        $this->assertFalse($outside->valid);
        $this->assertSame('offline_grace_expired', $outside->reason);
    }

    public function testA5xxIsOfflineNotAVerdict(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->status = 503;
        $server->now += 25 * FakeServer::HOUR;

        $state = $sdk->validate();
        $this->assertTrue($state->valid);
        $this->assertTrue($state->offline);
    }

    /**
     * @return array<string, array{string}>
     */
    public function tampering(): array
    {
        return [
            'a forged signature' => ['signature'],
            'an edited payload' => ['payload'],
            'a replayed answer (wrong nonce)' => ['nonce'],
            'an answer for another product' => ['product'],
        ];
    }

    /**
     * Not the forged "valid", and not the real "revoked" either — the answer
     * is treated as no answer, so the last good one stands inside the grace.
     *
     * @dataProvider tampering
     */
    public function testATamperedAnswerIsNotBelieved(string $kind): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->valid = false;
        $server->reason = 'license_revoked';
        $server->tamper = $kind;
        $server->now += 25 * FakeServer::HOUR;

        $state = $sdk->validate();

        $this->assertSame('offline', $state->source);
        $this->assertTrue($state->offline);
    }

    public function testWithNothingGoodToFallBackOnAnUntrustedAnswerSaysSo(): void
    {
        $server = new FakeServer();
        $storage = new MemoryStorage();
        $sdk = $this->client($server, ['storage' => $storage]);
        $sdk->activate(FakeServer::KEY);

        $record = json_decode((string) $storage->get('licence-app:invoice-pro'), true);
        $storage->set('licence-app:invoice-pro', (string) json_encode(['answer' => null, 'lastGood' => null] + $record));

        $server->tamper = 'signature';
        $state = $sdk->validate();

        $this->assertFalse($state->valid);
        $this->assertSame('untrusted_response', $state->reason);
    }

    public function testAnEditedCacheIsNotBelieved(): void
    {
        $server = new FakeServer();
        $storage = new MemoryStorage();
        $sdk = $this->client($server, ['storage' => $storage]);
        $sdk->activate(FakeServer::KEY);

        $record = json_decode((string) $storage->get('licence-app:invoice-pro'), true);
        $record['answer']['payload'] = rtrim(strtr(base64_encode((string) json_encode([
            'valid' => true, 'reason' => null, 'product' => 'invoice-pro', 'checked_at' => '2099-01-01T00:00:00Z',
        ])), '+/', '-_'), '=');
        $storage->set('licence-app:invoice-pro', (string) json_encode($record));

        $sdk->validate();

        $this->assertCount(2, $server->calls, 'the forged cache was ignored and the server asked');
    }

    public function testKeepsOneInstallationIdAcrossRestarts(): void
    {
        $server = new FakeServer();
        $storage = new MemoryStorage();

        $first = $this->client($server, ['storage' => $storage]);
        $id = $first->instanceId();
        $first->activate(FakeServer::KEY);

        $second = $this->client($server, ['storage' => $storage]);
        $this->assertSame($id, $second->instanceId());
        $this->assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $id);
        $this->assertTrue($second->validate()->valid, 'and the key came with it');
    }

    public function testDeactivatingFreesTheSlotAndForgetsTheKey(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $this->assertTrue($sdk->deactivate());
        $this->assertCount(0, $server->activated);
        $this->assertSame('no_license_key', $sdk->validate()->reason);
    }

    public function testDeactivatingOfflineStillForgetsTheKey(): void
    {
        $server = new FakeServer();
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $server->down = true;

        $this->assertFalse($sdk->deactivate());
        $this->assertNull($sdk->licenseKey());
    }

    public function testReportsChangesAndOnlyChanges(): void
    {
        $server = new FakeServer();
        $seen = [];
        $sdk = $this->client($server, ['on_change' => function (LicenseState $state) use (&$seen): void {
            $seen[] = $state->reason ?? 'valid';
        }]);

        $sdk->activate(FakeServer::KEY);
        $sdk->validate(true);

        $server->valid = false;
        $server->reason = 'license_expired';
        $sdk->validate(true);

        $this->assertSame(['valid', 'license_expired'], $seen);
    }

    public function testAMalformedRequestIsAThrownErrorNotAState(): void
    {
        $this->expectException(LicenseSdkException::class);

        $this->client(new FakeServer())->activate('');
    }

    public function testActivationNeedsTheServerAndThrowsWhenThereIsNone(): void
    {
        $server = new FakeServer();
        $server->down = true;

        try {
            $this->client($server)->activate(FakeServer::KEY);
            $this->fail('expected an exception');
        } catch (LicenseSdkException $e) {
            $this->assertSame(LicenseSdkException::NETWORK, $e->reason());
        }
    }

    public function testActivationWithAWrongPinnedKeyThrowsUntrusted(): void
    {
        $server = new FakeServer();
        $other = new FakeServer();

        try {
            $this->client($server, ['public_key' => ['k1' => $other->publicKey]])->activate(FakeServer::KEY);
            $this->fail('expected an exception');
        } catch (LicenseSdkException $e) {
            $this->assertSame(LicenseSdkException::UNTRUSTED_RESPONSE, $e->reason());
        }
    }

    public function testKeysArePinnedByKid(): void
    {
        $server = new FakeServer();

        $state = $this->client($server, ['public_key' => ['k0' => (new FakeServer())->publicKey, 'k1' => $server->publicKey]])
            ->activate(FakeServer::KEY);

        $this->assertTrue($state->valid, 'the k1 answer verified against the k1 key');
    }

    public function testFileStorageKeepsTheRecordOnDiskPrivateToTheUser(): void
    {
        $server = new FakeServer();
        $path = sys_get_temp_dir() . '/licence-sdk-' . bin2hex(random_bytes(4)) . '/nested/license.json';

        $this->client($server, ['storage' => new FileStorage($path)])->activate(FakeServer::KEY);

        $onDisk = json_decode((string) file_get_contents($path), true);
        $this->assertArrayHasKey('licence-app:invoice-pro', $onDisk);
        $this->assertSame('0600', substr(sprintf('%o', fileperms($path)), -4));

        $restarted = $this->client($server, ['storage' => new FileStorage($path)]);
        $this->assertTrue($restarted->validate()->valid);
    }

    public function testTheLatestReleaseIsVerifiedAndLinkedForALicensedInstall(): void
    {
        $server = new FakeServer();
        $server->release = ['version' => '1.3.0'];
        $sdk = $this->client($server);
        $sdk->activate(FakeServer::KEY);

        $check = $sdk->latestRelease();

        $this->assertNotNull($check);
        $this->assertSame('1.3.0', $check->version());
        $this->assertTrue($check->updateAllowed);
        $this->assertNotNull($check->downloadUrl);
        $this->assertTrue($check->isNewerThan('1.2.9'));
        $this->assertFalse($check->isNewerThan('1.3.0'));

        $call = end($server->calls);
        $this->assertSame('GET', $call['method']);
        $this->assertSame(FakeServer::KEY, $call['body']['license_key']);
        $this->assertSame($sdk->instanceId(), $call['body']['instance_id']);
    }

    public function testWithoutAKeyTheReleaseIsDescribedButNotLinked(): void
    {
        $server = new FakeServer();
        $server->release = ['version' => '1.3.0'];

        $check = $this->client($server)->latestRelease();

        $this->assertNotNull($check);
        $this->assertFalse($check->updateAllowed);
        $this->assertSame('license_required', $check->reason);
        $this->assertNull($check->downloadUrl);
        $this->assertArrayNotHasKey('instance_id', end($server->calls)['body']);
    }

    public function testAnUnverifiableOrUnreachableReleaseCheckIsNoInformation(): void
    {
        $server = new FakeServer();
        $server->release = ['version' => '1.3.0'];
        $sdk = $this->client($server);

        $server->tamper = 'nonce';
        $this->assertNull($sdk->latestRelease());

        $server->tamper = null;
        $server->down = true;
        $this->assertNull($sdk->latestRelease());
    }

    /**
     * @return array<string, array{string, string, bool}>
     */
    public function versions(): array
    {
        return [
            'patch' => ['1.2.1', '1.2.0', true],
            'numeric, not string' => ['1.10.0', '1.9.0', true],
            'same' => ['1.2.0', '1.2.0', false],
            'older' => ['1.1.0', '1.2.0', false],
            'the release after its beta' => ['2.0.0', '2.0.0-beta.2', true],
            'a beta before its release' => ['2.0.0-beta.2', '1.9.0', true],
            'beta ordering' => ['2.0.0-beta.2', '2.0.0-beta.1', true],
            'rc after beta' => ['2.0.0-rc.1', '2.0.0-beta.3', true],
            'a leading v' => ['v1.3.0', '1.2.0', true],
        ];
    }

    /**
     * @dataProvider versions
     */
    public function testComparesVersionsLikeTheServer(string $release, string $installed, bool $newer): void
    {
        $check = new \LicenceApp\Sdk\UpdateCheck(['version' => $release], true, null, null);

        $this->assertSame($newer, $check->isNewerThan($installed));
    }
}

