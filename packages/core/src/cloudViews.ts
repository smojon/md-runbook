/**
 * Cloud console views: when a cell prints JSON from the AWS or Google Cloud CLI, a table of the
 * resources with a link to each in the cloud console (as Runme's cloud renderers do). Recognized
 * by the JSON's shape, so `aws ec2 describe-instances` and `gcloud … --format=json` both work:
 * EC2 instances, EKS clusters, Compute Engine instances, GKE clusters, Cloud Run services.
 * Display only: nothing of it is saved in the file.
 */

export interface CloudRow {
  cells: string[];
  /** The resource in the cloud console. */
  url: string;
}

export interface CloudView {
  /** "EC2 instances", "GKE clusters", … */
  title: string;
  columns: string[];
  rows: CloudRow[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const last = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';
const q = encodeURIComponent;

/** The JSON a command printed: the whole output, or from its first `{` or `[` (after a warning line). */
export function parseJsonOutput(text: string): unknown {
  const t = text.trim();
  for (const start of [0, t.search(/^[[{]/m)]) {
    if (start < 0) continue;
    try {
      return JSON.parse(t.slice(start));
    } catch {
      // not JSON from here
    }
  }
  return undefined;
}

function ec2(json: unknown): CloudView | undefined {
  if (!isObj(json) || !Array.isArray(json.Reservations)) return undefined;
  const instances = json.Reservations.flatMap((r) => (isObj(r) && Array.isArray(r.Instances) ? r.Instances.filter(isObj) : []));
  if (instances.length === 0) return undefined;
  return {
    title: 'EC2 instances',
    columns: ['Name', 'Instance', 'Type', 'State', 'Zone', 'Private IP', 'Public IP'],
    rows: instances.map((i) => {
      const id = str(i.InstanceId);
      const zone = isObj(i.Placement) ? str(i.Placement.AvailabilityZone) : '';
      const region = zone.replace(/[a-z]$/, '');
      const name = Array.isArray(i.Tags) ? str(i.Tags.filter(isObj).find((t) => t.Key === 'Name')?.Value) : '';
      return {
        cells: [name, id, str(i.InstanceType), isObj(i.State) ? str(i.State.Name) : '', zone, str(i.PrivateIpAddress), str(i.PublicIpAddress)],
        url: region
          ? `https://${region}.console.aws.amazon.com/ec2/home?region=${q(region)}#InstanceDetails:instanceId=${q(id)}`
          : `https://console.aws.amazon.com/ec2/home#InstanceDetails:instanceId=${q(id)}`,
      };
    }),
  };
}

function eks(json: unknown): CloudView | undefined {
  if (!isObj(json)) return undefined;
  const eksUrl = (name: string, region: string): string =>
    region ? `https://${region}.console.aws.amazon.com/eks/home?region=${q(region)}#/clusters/${q(name)}` : `https://console.aws.amazon.com/eks/home#/clusters/${q(name)}`;
  // describe-cluster: { cluster: { name, arn: arn:aws:eks:REGION:ACCOUNT:cluster/NAME, … } }
  if (isObj(json.cluster) && /^arn:aws[\w-]*:eks:/.test(str(json.cluster.arn))) {
    const c = json.cluster;
    const region = str(c.arn).split(':')[3] ?? '';
    return {
      title: 'EKS cluster',
      columns: ['Name', 'Status', 'Version', 'Region'],
      rows: [{ cells: [str(c.name), str(c.status), str(c.version), region], url: eksUrl(str(c.name), region) }],
    };
  }
  // list-clusters: { clusters: [names] } (no region in the output: the console's default)
  if (Array.isArray(json.clusters) && json.clusters.length > 0 && json.clusters.every((c) => typeof c === 'string') && Object.keys(json).every((k) => k === 'clusters' || k === 'nextToken')) {
    return { title: 'EKS clusters', columns: ['Name'], rows: (json.clusters as string[]).map((n) => ({ cells: [n], url: eksUrl(n, '') })) };
  }
  return undefined;
}

/** gcloud prints a list as an array and `describe` as one object. */
const asList = (json: unknown): Json[] => (Array.isArray(json) ? json.filter(isObj) : isObj(json) ? [json] : []);

function gce(json: unknown): CloudView | undefined {
  const items = asList(json).filter((i) => i.kind === 'compute#instance');
  if (items.length === 0) return undefined;
  return {
    title: 'Compute Engine instances',
    columns: ['Name', 'Zone', 'Machine type', 'Status', 'Internal IP', 'External IP'],
    rows: items.map((i) => {
      const project = /\/projects\/([^/]+)\//.exec(str(i.selfLink))?.[1] ?? '';
      const zone = last(str(i.zone));
      const nic = Array.isArray(i.networkInterfaces) && isObj(i.networkInterfaces[0]) ? i.networkInterfaces[0] : undefined;
      const access = nic && Array.isArray(nic.accessConfigs) && isObj(nic.accessConfigs[0]) ? nic.accessConfigs[0] : undefined;
      return {
        cells: [str(i.name), zone, last(str(i.machineType)), str(i.status), str(nic?.networkIP), str(access?.natIP)],
        url: `https://console.cloud.google.com/compute/instancesDetail/zones/${q(zone)}/instances/${q(str(i.name))}?project=${q(project)}`,
      };
    }),
  };
}

function gke(json: unknown): CloudView | undefined {
  const items = asList(json).filter((c) => /container\.googleapis\.com\/.*\/clusters\//.test(str(c.selfLink)));
  if (items.length === 0) return undefined;
  return {
    title: 'GKE clusters',
    columns: ['Name', 'Location', 'Status', 'Version', 'Nodes'],
    rows: items.map((c) => {
      const m = /\/projects\/([^/]+)\/(?:locations|zones)\/([^/]+)\/clusters\/([^/]+)/.exec(str(c.selfLink));
      const [project, location, name] = [m?.[1] ?? '', str(c.location) || (m?.[2] ?? ''), str(c.name) || (m?.[3] ?? '')];
      return {
        cells: [name, location, str(c.status), str(c.currentMasterVersion), str(c.currentNodeCount)],
        url: `https://console.cloud.google.com/kubernetes/clusters/details/${q(location)}/${q(name)}/details?project=${q(project)}`,
      };
    }),
  };
}

function cloudRun(json: unknown): CloudView | undefined {
  const items = asList(json).filter((s) => str(s.apiVersion).startsWith('serving.knative.dev/') && s.kind === 'Service' && isObj(s.metadata));
  if (items.length === 0) return undefined;
  return {
    title: 'Cloud Run services',
    columns: ['Name', 'Region', 'URL', 'Ready'],
    rows: items.map((s) => {
      const meta = s.metadata as Json;
      const labels = isObj(meta.labels) ? meta.labels : {};
      const region = str(labels['cloud.googleapis.com/location']);
      const status = isObj(s.status) ? s.status : {};
      const ready = Array.isArray(status.conditions) ? str(status.conditions.filter(isObj).find((c) => c.type === 'Ready')?.status) : '';
      return {
        cells: [str(meta.name), region, str(status.url), ready],
        url: `https://console.cloud.google.com/run/detail/${q(region)}/${q(str(meta.name))}/metrics?project=${q(str(meta.namespace))}`,
      };
    }),
  };
}

/** The console view of a cell's standard output, or undefined when it isn't one of the kinds above. */
export function cloudView(stdout: string): CloudView | undefined {
  if (!/^\s*[[{]/m.test(stdout)) return undefined;
  const json = parseJsonOutput(stdout);
  if (json === undefined) return undefined;
  for (const view of [ec2, eks, gce, gke, cloudRun]) {
    const v = view(json);
    if (v && v.rows.length > 0) return v;
  }
  return undefined;
}

const cellText = (s: string): string => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ') || ' ';

/** The view as a Markdown table, a console link in each row (VS Code shows it under the output). */
export function cloudViewMarkdown(v: CloudView): string {
  const head = `| ${[...v.columns, 'Console'].join(' | ')} |\n|${[...v.columns, 'Console'].map(() => ' --- ').join('|')}|\n`;
  const rows = v.rows.map((r) => `| ${r.cells.map(cellText).join(' | ')} | [Open](${r.url}) |`).join('\n');
  return `**${v.title}** (${v.rows.length})\n\n${head}${rows}\n`;
}
