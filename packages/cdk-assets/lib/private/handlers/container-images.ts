import * as path from 'path';
import type { DockerImageDestination } from '@aws-cdk/cloud-assembly-schema';
import { destinationToClientOptions } from './client-options';
import type { DockerImageManifestEntry } from '../../asset-manifest';
import type { IECRClient } from '../../aws';
import { EventType, shellEventPublisherFromEventEmitter } from '../../progress';
import type { IAssetHandler, IHandlerHost, IHandlerOptions } from '../asset-handler';
import type { Docker } from '../docker';
import { replaceAwsPlaceholders } from '../placeholders';
import { shell } from '../shell';

interface ContainerImageAssetHandlerInit {
  readonly ecr: IECRClient;
  readonly repoUri: string;
  readonly imageUri: string;
  readonly destinationAlreadyExists: boolean;
}

export class ContainerImageAssetHandler implements IAssetHandler {
  private init?: ContainerImageAssetHandlerInit;

  constructor(
    private readonly workDir: string,
    private readonly asset: DockerImageManifestEntry,
    private readonly host: IHandlerHost,
    private readonly options: IHandlerOptions,
  ) {
  }

  public async build(): Promise<void> {
    const initOnce = await this.initOnce();

    if (initOnce.destinationAlreadyExists) {
      return;
    }
    if (this.host.aborted) {
      return;
    }

    const dockerForBuilding = await this.host.dockerFactory.forBuild({
      repoUri: initOnce.repoUri,
      eventEmitter: (m: string) => this.host.emitMessage(EventType.DEBUG, m),
      ecr: initOnce.ecr,
      subprocessOutputDestination: this.options.subprocessOutputDestination,
    });

    const builder = new ContainerImageBuilder(
      dockerForBuilding,
      this.workDir,
      this.asset,
      this.host,
    );
    const localTagName = await builder.build();

    if (localTagName === undefined || this.host.aborted) {
      return;
    }
    if (this.host.aborted) {
      return;
    }

    await dockerForBuilding.tag(localTagName, initOnce.imageUri);
  }

  public async isPublished(): Promise<boolean> {
    try {
      const initOnce = await this.initOnce({ quiet: true });
      return initOnce.destinationAlreadyExists;
    } catch (e: any) {
      this.host.emitMessage(EventType.DEBUG, `${e.message}`);
    }
    return false;
  }

  public async publish(): Promise<void> {
    const initOnce = await this.initOnce();

    if (initOnce.destinationAlreadyExists) {
      return;
    }
    if (this.host.aborted) {
      return;
    }

    const dockerForPushing = await this.host.dockerFactory.forEcrPush({
      repoUri: initOnce.repoUri,
      eventEmitter: this.host.emitMessage,
      ecr: initOnce.ecr,
      subprocessOutputDestination: this.options.subprocessOutputDestination,
    });

    if (this.host.aborted) {
      return;
    }

    this.host.emitMessage(EventType.UPLOAD, `Push ${initOnce.imageUri}`);
    await dockerForPushing.push({
      tag: initOnce.imageUri,
    });
  }

  private async initOnce(
    options: { quiet?: boolean } = {},
  ): Promise<ContainerImageAssetHandlerInit> {
    if (this.init) {
      return this.init;
    }

    const destination = await replaceAwsPlaceholders(this.asset.destination, this.host.aws);
    const ecr = await this.host.aws.ecrClient({
      ...destinationToClientOptions(destination),
      quiet: options.quiet,
    });
    const account = async () => (await this.host.aws.discoverCurrentAccount())?.accountId;

    const repoUri = await repositoryUri(ecr, destination.repositoryName);
    if (!repoUri) {
      throw new Error(
        `No ECR repository named '${destination.repositoryName}' in account ${await account()}. Is this account bootstrapped?`,
      );
    }

    const imageUri = `${repoUri}:${destination.imageTag}`;

    this.init = {
      imageUri,
      ecr,
      repoUri,
      destinationAlreadyExists: await this.destinationAlreadyExists(ecr, destination, imageUri),
    };

    return this.init;
  }

  /**
   * Check whether the image already exists in the ECR repo
   *
   * Use the fields from the destination to do the actual check. The imageUri
   * should correspond to that, but is only used to print Docker image location
   * for user benefit (the format is slightly different).
   */
  private async destinationAlreadyExists(
    ecr: IECRClient,
    destination: DockerImageDestination,
    imageUri: string,
  ): Promise<boolean> {
    this.host.emitMessage(EventType.CHECK, `Check ${imageUri}`);
    if (await imageExists(ecr, destination.repositoryName, destination.imageTag)) {
      this.host.emitMessage(EventType.FOUND, `Found ${imageUri}`);
      return true;
    }

    return false;
  }
}

class ContainerImageBuilder {
  constructor(
    private readonly docker: Docker,
    private readonly workDir: string,
    private readonly asset: DockerImageManifestEntry,
    private readonly host: IHandlerHost,
  ) {
  }

  async build(): Promise<string | undefined> {
    return this.asset.source.executable
      ? this.buildExternalAsset(this.asset.source.executable)
      : this.buildDirectoryAsset();
  }

  /**
   * Build a (local) Docker asset from a directory with a Dockerfile
   *
   * Tags under a deterministic, unique, local identifier wich will skip
   * the build if it already exists.
   */
  private async buildDirectoryAsset(): Promise<string | undefined> {
    const localTagName = `cdkasset-${this.asset.id.assetId.toLowerCase()}`;

    if (!(await this.isImageCached(localTagName))) {
      if (this.host.aborted) {
        return undefined;
      }

      await this.buildImage(localTagName);
    }

    return localTagName;
  }

  /**
   * Build a (local) Docker asset by running an external command
   *
   * External command is responsible for deduplicating the build if possible,
   * and is expected to return the generated image identifier on stdout.
   */
  private async buildExternalAsset(
    executable: string[],
    cwd?: string,
  ): Promise<string | undefined> {
    const assetPath = cwd ?? this.workDir;

    this.host.emitMessage(EventType.BUILD, `Building Docker image using command '${executable}'`);
    if (this.host.aborted) {
      return undefined;
    }

    const shellEventPublisher = shellEventPublisherFromEventEmitter(this.host.emitMessage);

    return (
      await shell(executable, {
        cwd: assetPath,
        shellEventPublisher,
        subprocessOutputDestination: 'ignore',
      })
    ).trim();
  }

  private async buildImage(localTagName: string): Promise<void> {
    const source = this.asset.source;
    if (!source.directory) {
      throw new Error(
        `'directory' is expected in the DockerImage asset source, got: ${JSON.stringify(source)}`,
      );
    }

    const fullPath = path.resolve(this.workDir, source.directory);
    this.host.emitMessage(EventType.BUILD, `Building Docker image at ${fullPath}`);

    await this.docker.build({
      directory: fullPath,
      tag: localTagName,
      buildArgs: source.dockerBuildArgs,
      buildSecrets: source.dockerBuildSecrets,
      buildSsh: source.dockerBuildSsh,
      target: source.dockerBuildTarget,
      file: source.dockerFile,
      networkMode: source.networkMode,
      platform: source.platform,
      outputs: source.dockerOutputs,
      cacheFrom: source.cacheFrom,
      cacheTo: source.cacheTo,
      cacheDisabled: source.cacheDisabled,
    });
  }

  private async isImageCached(localTagName: string): Promise<boolean> {
    if (await this.docker.exists(localTagName)) {
      this.host.emitMessage(EventType.CACHED, `Cached ${localTagName}`);
      return true;
    }

    return false;
  }
}

async function imageExists(ecr: IECRClient, repositoryName: string, imageTag: string) {
  try {
    await ecr.describeImages({
      repositoryName,
      imageIds: [{ imageTag }],
    });
    return true;
  } catch (e: any) {
    if (e.name !== 'ImageNotFoundException') {
      throw e;
    }
    return false;
  }
}

/**
 * Return the URI for the repository with the given name
 *
 * Returns undefined if the repository does not exist.
 */
async function repositoryUri(ecr: IECRClient, repositoryName: string): Promise<string | undefined> {
  try {
    const response = await ecr.describeRepositories({
      repositoryNames: [repositoryName],
    });
    return (response.repositories || [])[0]?.repositoryUri;
  } catch (e: any) {
    if (e.name !== 'RepositoryNotFoundException') {
      throw e;
    }
    return undefined;
  }
}
