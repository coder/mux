export class ServerService {
  private launchProjectPath: string | null = null;

  /**
   * Set the launch project path
   */
  setLaunchProject(path: string | null): void {
    this.launchProjectPath = path;
  }

  /**
   * Get the launch project path
   */
  getLaunchProject(): Promise<string | null> {
    return Promise.resolve(this.launchProjectPath);
  }
}
