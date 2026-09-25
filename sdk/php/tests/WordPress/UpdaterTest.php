<?php

namespace LicenceApp\Sdk\Tests\WordPress;

use LicenceApp\Sdk\Tests\FakeServer;
use LicenceApp\Sdk\WordPress\OptionStorage;
use LicenceApp\Sdk\WordPress\Plugin;
use LicenceApp\Sdk\WordPress\SettingsPage;
use LicenceApp\Sdk\WordPress\Updater;
use LicenceApp\Sdk\WordPress\WordPressHttpClient;
use LicenceApp\Sdk\Client;
use PHPUnit\Framework\TestCase;

/**
 * The updater against WordPress's hooks, with the options, transients and
 * HTTP of a stubbed WordPress routed to the signing fake server.
 */
final class UpdaterTest extends TestCase
{
    private const FILE = WP_PLUGIN_DIR . '/invoice-pro/invoice-pro.php';
    private const BASENAME = 'invoice-pro/invoice-pro.php';

    /** @var FakeServer */
    private $server;

    /** @var Client */
    private $client;

    protected function setUp(): void
    {
        \WpStubs::reset();
        $this->server = new FakeServer();
        $this->server->release = ['version' => '1.3.0'];
        \WpStubs::$http = $this->server;

        $this->client = new Client([
            'base_url' => 'https://licenses.test/api/v1',
            'product' => 'invoice-pro',
            'public_key' => $this->server->publicKey,
            'storage' => new OptionStorage(),
            'http' => new WordPressHttpClient(),
            'now' => $this->server->clock(),
        ]);
    }

    private function updater(string $version = '1.2.0'): Updater
    {
        return new Updater($this->client, ['plugin_file' => self::FILE, 'version' => $version, 'name' => 'Invoice Pro']);
    }

    private function transient(): object
    {
        return (object) ['checked' => [self::BASENAME => '1.2.0'], 'response' => [], 'no_update' => []];
    }

    public function testRegistersOnWordPressUpdateHooks(): void
    {
        $this->updater()->register();

        foreach (['pre_set_site_transient_update_plugins', 'plugins_api', 'upgrader_pre_download', 'upgrader_process_complete'] as $hook) {
            $this->assertArrayHasKey($hook, \WpStubs::$hooks, $hook);
        }
    }

    public function testOffersANewerVersionWithItsPackageToALicensedSite(): void
    {
        $this->client->activate(FakeServer::KEY);

        $transient = $this->updater()->injectUpdate($this->transient());

        $item = $transient->response[self::BASENAME];
        $this->assertSame('1.3.0', $item->new_version);
        $this->assertSame('invoice-pro', $item->slug);
        $this->assertSame(self::BASENAME, $item->plugin);
        $this->assertStringContainsString('/releases/rel_test/download', $item->package);
        $this->assertSame('6.5', $item->requires);
        $this->assertSame('7.4', $item->requires_php);
        $this->assertSame('6.8', $item->tested);
        $this->assertArrayNotHasKey(self::BASENAME, $transient->no_update);
    }

    public function testNothingNewerGoesToNoUpdate(): void
    {
        $this->client->activate(FakeServer::KEY);

        $transient = $this->updater('1.3.0')->injectUpdate($this->transient());

        $this->assertArrayNotHasKey(self::BASENAME, $transient->response);
        $this->assertSame('1.3.0', $transient->no_update[self::BASENAME]->new_version);
    }

    /**
     * Plan Q4: updates ran out, the plugin keeps working, and the admin sees
     * the new version with a reason instead of a package.
     */
    public function testAnUncoveredUpdateIsShownWithoutAPackageAndSaysWhy(): void
    {
        $this->client->activate(FakeServer::KEY);
        $this->server->updateAllowed = false;
        $this->server->updateReason = 'updates_expired';

        $item = $this->updater()->injectUpdate($this->transient())->response[self::BASENAME];

        $this->assertSame('', $item->package);
        $this->assertStringContainsString('update period has ended', $item->upgrade_notice);
    }

    public function testAsksTheServerOncePerCachePeriod(): void
    {
        $this->client->activate(FakeServer::KEY);
        $updater = $this->updater();

        $updater->injectUpdate($this->transient());
        $updater->injectUpdate($this->transient());
        $updater->pluginInfo(false, 'plugin_information', (object) ['slug' => 'invoice-pro']);

        $this->assertCount(1, $this->latestCalls());

        $updater->forget();
        $updater->injectUpdate($this->transient());
        $this->assertCount(2, $this->latestCalls());
    }

    public function testAnUnreachableServerChangesNothingAndIsNotAskedAgainAtOnce(): void
    {
        $this->server->down = true;
        $updater = $this->updater();

        $transient = $updater->injectUpdate($this->transient());
        $this->assertSame([], $transient->response);

        $this->server->down = false;
        $updater->injectUpdate($this->transient());
        $this->assertCount(0, $this->latestCalls(), 'the failure is cached');
    }

    public function testLeavesOtherTransientsAlone(): void
    {
        $this->assertFalse($this->updater()->injectUpdate(false));
    }

    public function testDescribesTheReleaseInTheDetailsPopup(): void
    {
        $this->client->activate(FakeServer::KEY);

        $info = $this->updater()->pluginInfo(false, 'plugin_information', (object) ['slug' => 'invoice-pro']);

        $this->assertSame('Invoice Pro', $info->name);
        $this->assertSame('1.3.0', $info->version);
        $this->assertSame('6.5', $info->requires);
        $this->assertStringContainsString('Faster.', $info->sections['changelog']);
    }

    public function testIgnoresOtherPluginsDetails(): void
    {
        $result = $this->updater()->pluginInfo('untouched', 'plugin_information', (object) ['slug' => 'another-plugin']);

        $this->assertSame('untouched', $result);
        $this->assertCount(0, $this->latestCalls());
    }

    public function testInstallsWithAFreshLinkAndAVerifiedChecksum(): void
    {
        $this->client->activate(FakeServer::KEY);
        $before = count($this->latestCalls());

        $file = $this->updater()->preDownload(false, 'https://old-link', null, ['plugin' => self::BASENAME]);

        $this->assertIsString($file);
        $this->assertSame($this->server->package, file_get_contents($file));
        $this->assertCount($before + 1, $this->latestCalls(), 'a fresh link was asked for');
        unlink($file);
    }

    public function testRefusesAPackageThatDoesNotMatchItsSignedChecksum(): void
    {
        $this->client->activate(FakeServer::KEY);
        $this->server->checksum = hash('sha256', 'something else');

        $result = $this->updater()->preDownload(false, 'https://old-link', null, ['plugin' => self::BASENAME]);

        $this->assertInstanceOf(\WP_Error::class, $result);
        $this->assertSame('licence_app_checksum_mismatch', $result->get_error_code());
    }

    public function testRefusesToDownloadWhatTheLicenseDoesNotCover(): void
    {
        $this->client->activate(FakeServer::KEY);
        $this->server->updateAllowed = false;
        $this->server->updateReason = 'license_expired';

        $result = $this->updater()->preDownload(false, 'https://old-link', null, ['plugin' => self::BASENAME]);

        $this->assertInstanceOf(\WP_Error::class, $result);
        $this->assertStringContainsString('expired', $result->get_error_message());
    }

    public function testLeavesOtherPluginsDownloadsToWordPress(): void
    {
        $this->assertFalse($this->updater()->preDownload(false, 'https://x', null, ['plugin' => 'akismet/akismet.php']));
        $this->assertSame('already', $this->updater()->preDownload('already', 'https://x', null, ['plugin' => self::BASENAME]));
    }

    public function testTheRecordLivesInOneNonAutoloadedOption(): void
    {
        $this->client->activate(FakeServer::KEY);

        $this->assertSame(['licence_app_invoice_pro'], array_keys(\WpStubs::$options));
    }

    public function testBootWiresTheClientTheUpdaterAndTheSettingsPage(): void
    {
        $client = Plugin::boot([
            'plugin_file' => self::FILE,
            'version' => '1.2.0',
            'name' => 'Invoice Pro',
            'base_url' => 'https://licenses.test/api/v1',
            'product' => 'invoice-pro',
            'public_key' => $this->server->publicKey,
        ]);

        $this->assertTrue($client->activate(FakeServer::KEY)->valid);
        $this->assertArrayHasKey('pre_set_site_transient_update_plugins', \WpStubs::$hooks);
        $this->assertArrayHasKey('admin_menu', \WpStubs::$hooks);
        $this->assertArrayHasKey('admin_post_licence_app_invoice_pro', \WpStubs::$hooks);
    }

    public function testDescribesEveryReasonInPlainWords(): void
    {
        $this->assertSame('Active', SettingsPage::describe(true, null, false));
        $this->assertStringContainsString('last check', SettingsPage::describe(true, null, true));

        foreach (['no_license_key', 'invalid_license', 'license_expired', 'activation_limit_reached', 'offline_grace_expired'] as $reason) {
            $this->assertNotSame($reason, SettingsPage::describe(false, $reason, false), $reason);
        }
    }

    /**
     * @return array<int, mixed>
     */
    private function latestCalls(): array
    {
        return array_values(array_filter($this->server->calls, static function (array $call): bool {
            return $call['action'] === 'latest';
        }));
    }
}
