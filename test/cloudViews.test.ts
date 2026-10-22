import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cloudView, cloudViewMarkdown } from '@md-runbook/core/cloudViews';

const ec2 = {
  Reservations: [
    {
      Instances: [
        {
          InstanceId: 'i-0abc123',
          InstanceType: 't3.micro',
          State: { Code: 16, Name: 'running' },
          Placement: { AvailabilityZone: 'eu-central-1b' },
          PrivateIpAddress: '10.0.1.5',
          PublicIpAddress: '3.120.1.2',
          Tags: [{ Key: 'Name', Value: 'web-1' }],
        },
      ],
    },
  ],
};

describe('cloud console views', () => {
  it('EC2 instances (aws ec2 describe-instances), with a link to each in its region', () => {
    const v = cloudView(JSON.stringify(ec2, null, 2))!;
    assert.equal(v.title, 'EC2 instances');
    assert.deepEqual(v.rows[0]!.cells, ['web-1', 'i-0abc123', 't3.micro', 'running', 'eu-central-1b', '10.0.1.5', '3.120.1.2']);
    assert.equal(v.rows[0]!.url, 'https://eu-central-1.console.aws.amazon.com/ec2/home?region=eu-central-1#InstanceDetails:instanceId=i-0abc123');
  });

  it('EKS clusters: describe-cluster (region from the ARN) and list-clusters', () => {
    const one = cloudView(JSON.stringify({ cluster: { name: 'prod', arn: 'arn:aws:eks:us-east-1:123456789012:cluster/prod', status: 'ACTIVE', version: '1.31' } }))!;
    assert.deepEqual([one.title, one.rows[0]!.cells, one.rows[0]!.url], [
      'EKS cluster',
      ['prod', 'ACTIVE', '1.31', 'us-east-1'],
      'https://us-east-1.console.aws.amazon.com/eks/home?region=us-east-1#/clusters/prod',
    ]);
    assert.deepEqual(cloudView('{"clusters": ["a", "b"]}')!.rows.map((r) => r.cells[0]), ['a', 'b']);
  });

  it('Compute Engine instances (gcloud compute instances list/describe --format=json)', () => {
    const vm = {
      kind: 'compute#instance',
      name: 'vm-1',
      zone: 'https://www.googleapis.com/compute/v1/projects/shop-prod/zones/europe-west6-a',
      machineType: 'https://www.googleapis.com/compute/v1/projects/shop-prod/zones/europe-west6-a/machineTypes/e2-medium',
      status: 'RUNNING',
      selfLink: 'https://www.googleapis.com/compute/v1/projects/shop-prod/zones/europe-west6-a/instances/vm-1',
      networkInterfaces: [{ networkIP: '10.172.0.2', accessConfigs: [{ natIP: '34.65.1.1' }] }],
    };
    for (const out of [JSON.stringify([vm]), JSON.stringify(vm)]) {
      const v = cloudView(out)!;
      assert.deepEqual(v.rows[0]!.cells, ['vm-1', 'europe-west6-a', 'e2-medium', 'RUNNING', '10.172.0.2', '34.65.1.1']);
      assert.equal(v.rows[0]!.url, 'https://console.cloud.google.com/compute/instancesDetail/zones/europe-west6-a/instances/vm-1?project=shop-prod');
    }
  });

  it('GKE clusters and Cloud Run services', () => {
    const gke = cloudView(
      JSON.stringify([
        {
          name: 'main',
          location: 'europe-west6',
          status: 'RUNNING',
          currentMasterVersion: '1.31.1-gke.1',
          currentNodeCount: 3,
          selfLink: 'https://container.googleapis.com/v1/projects/shop-prod/locations/europe-west6/clusters/main',
        },
      ]),
    )!;
    assert.deepEqual([gke.title, gke.rows[0]!.cells], ['GKE clusters', ['main', 'europe-west6', 'RUNNING', '1.31.1-gke.1', '3']]);
    assert.equal(gke.rows[0]!.url, 'https://console.cloud.google.com/kubernetes/clusters/details/europe-west6/main/details?project=shop-prod');
    const run = cloudView(
      JSON.stringify([
        {
          apiVersion: 'serving.knative.dev/v1',
          kind: 'Service',
          metadata: { name: 'api', namespace: '123456789', labels: { 'cloud.googleapis.com/location': 'europe-west6' } },
          status: { url: 'https://api-xyz.a.run.app', conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ]),
    )!;
    assert.deepEqual([run.title, run.rows[0]!.cells], ['Cloud Run services', ['api', 'europe-west6', 'https://api-xyz.a.run.app', 'True']]);
    assert.equal(run.rows[0]!.url, 'https://console.cloud.google.com/run/detail/europe-west6/api/metrics?project=123456789');
  });

  it('other output gets no view; a warning line before the JSON is fine', () => {
    for (const out of ['plain text', '{"name": "x"}', '[1, 2]', '[]', '{"Reservations": []}', '{"clusters": ["a"], "other": 1}']) assert.equal(cloudView(out), undefined, out);
    assert.equal(cloudView(`WARNING: something\n${JSON.stringify(ec2)}`)?.title, 'EC2 instances');
  });

  it('as a Markdown table with a console link per row; | in values is escaped', () => {
    const md = cloudViewMarkdown({ title: 'EC2 instances', columns: ['Name', 'State'], rows: [{ cells: ['a|b', ''], url: 'https://x' }] });
    assert.equal(md, '**EC2 instances** (1)\n\n| Name | State | Console |\n| --- | --- | --- |\n| a\\|b |   | [Open](https://x) |\n');
  });
});
