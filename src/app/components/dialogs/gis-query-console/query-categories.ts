export interface QueryParam {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select';
  default?: number | string;
  unit?: string;
  options?: string[];
}

export interface QueryBackend {
  /** Layer IDs this query runs against (first one is used). */
  layerIds: number[];
  /** Translate current params into queryParcels conditions. */
  toConditions: (
    params: Record<string, any>,
  ) => { field: string; operator: string; value: string }[];
  logic?: 'AND' | 'OR';
}

export interface QueryDef {
  id: string;
  name: string;
  description: string;
  params: QueryParam[];
  sql: (p: Record<string, any>) => string;
  /** If present, this query can be executed against the live backend. */
  backend?: QueryBackend;
}

export interface QueryCategory {
  label: string;
  icon: string;
  color: string;
  queries: QueryDef[];
}

export const QUERY_CATEGORIES: Record<string, QueryCategory> = {
  disaster: {
    label: 'Disaster & Risk',
    icon: 'warning',
    color: '#e74c3c',
    queries: [
      {
        id: 'flood_elev',
        name: 'Flood Risk by Elevation',
        description: 'Highlight parcels below a given elevation threshold',
        params: [
          { key: 'elevation', label: 'Max Elevation (m)', type: 'number', default: 5, unit: 'm' },
          {
            key: 'zone',
            label: 'Zone',
            type: 'select',
            options: [
              'All Wards',
              'Ward 1 - Fort',
              'Ward 2 - Pettah',
              'Ward 3 - Maradana',
              'Ward 4 - Slave Island',
              'Ward 5 - Kollupitiya',
            ],
          },
        ],
        sql: (p) =>
          `SELECT * FROM land_parcels\nWHERE elevation < ${p['elevation']}\n  AND zone = '${p['zone']}';`,
        backend: {
          // Runs against la_ls_physical_env.elevation. The "zone" (ward) filter has no
          // backend column yet, so it is preview-only and ignored server-side.
          layerIds: [1, 6],
          toConditions: (p) => [
            { field: 'elevation', operator: '<', value: String(p['elevation']) },
          ],
          logic: 'AND',
        },
      },
      {
        id: 'river_buffer',
        name: 'River Proximity Analysis',
        description: 'Find parcels within buffer distance of rivers/canals',
        params: [
          { key: 'buffer', label: 'Buffer Distance', type: 'number', default: 100, unit: 'm' },
          {
            key: 'river',
            label: 'Water Body',
            type: 'select',
            options: [
              'All Rivers',
              'Kelani River',
              'Beira Lake',
              'Diyawanna Oya',
              'San Sebastian Canal',
            ],
          },
        ],
        sql: (p) =>
          `SELECT p.* FROM land_parcels p\nJOIN water_bodies w ON\n  ST_DWithin(p.geom, w.geom, ${p['buffer']})\nWHERE w.name = '${p['river']}';`,
      },
      {
        id: 'landslide_slope',
        name: 'Landslide Susceptibility',
        description: 'Identify parcels on steep slopes with risk factors',
        params: [
          { key: 'slope', label: 'Min Slope', type: 'number', default: 30, unit: '\u00B0' },
          {
            key: 'soil',
            label: 'Soil Type',
            type: 'select',
            options: ['All Types', 'Laterite', 'Red-Yellow Podzolic', 'Alluvial', 'Bog & Half-Bog'],
          },
        ],
        sql: (p) =>
          `SELECT p.* FROM land_parcels p\nJOIN slope_data s ON ST_Intersects(p.geom, s.geom)\nJOIN soil_map sm ON ST_Intersects(p.geom, sm.geom)\nWHERE s.gradient > ${p['slope']}\n  AND sm.soil_type = '${p['soil']}';`,
        backend: {
          // Runs against la_ls_physical_env.slope / soil_type (per-parcel stored attributes).
          layerIds: [1, 6],
          toConditions: (p) => {
            const conds: { field: string; operator: string; value: string }[] = [
              { field: 'slope', operator: '>', value: String(p['slope']) },
            ];
            if (p['soil'] && p['soil'] !== 'All Types') {
              conds.push({ field: 'soil_type', operator: '%', value: String(p['soil']) });
            }
            return conds;
          },
          logic: 'AND',
        },
      },
      {
        id: 'coastal_zone',
        name: 'Coastal Reservation Violations',
        description: 'Structures within the coastal buffer zone',
        params: [
          { key: 'buffer', label: 'Coastal Buffer', type: 'number', default: 100, unit: 'm' },
        ],
        sql: (p) =>
          `SELECT b.* FROM buildings b\nJOIN coastline c ON\n  ST_DWithin(b.geom, c.geom, ${p['buffer']})\nWHERE b.permit_status != 'Approved';`,
      },
    ],
  },
  land: {
    label: 'Land & Property',
    icon: 'domain',
    color: '#2ecc71',
    queries: [
      {
        id: 'parcel_search',
        name: 'Parcel Search by Name',
        description: 'Search land parcels by name',
        params: [{ key: 'value', label: 'Search Value', type: 'text', default: '' }],
        sql: (p) => `SELECT * FROM land_parcels\nWHERE land_name ILIKE '%${p['value']}%';`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) =>
            p['value'] ? [{ field: 'land_name', operator: '%', value: String(p['value']) }] : [],
        },
      },
      {
        id: 'land_use',
        name: 'Land Use Classification',
        description: 'Query parcels by current land use type',
        params: [
          {
            key: 'use_type',
            label: 'Land Use',
            type: 'select',
            options: [
              'Residential',
              'Commercial',
              'Industrial',
              'Agricultural',
              'Mixed Use',
              'Vacant',
            ],
          },
          {
            key: 'min_area',
            label: 'Min Area (m²)',
            type: 'number',
            default: 0,
            unit: 'm²',
          },
        ],
        sql: (p) =>
          `SELECT * FROM land_parcels\nWHERE sl_land_type ILIKE '%${p['use_type']}%'\n  AND area >= ${p['min_area']};`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) => {
            const conds: { field: string; operator: string; value: string }[] = [
              { field: 'sl_land_type', operator: '%', value: String(p['use_type']) },
            ];
            if (Number(p['min_area']) > 0) {
              conds.push({ field: 'area_m2', operator: '>=', value: String(p['min_area']) });
            }
            return conds;
          },
          logic: 'AND',
        },
      },
      {
        id: 'vacant_land',
        name: 'Vacant / Undeveloped Land',
        description: 'Find undeveloped parcels above minimum area',
        params: [
          {
            key: 'min_area',
            label: 'Min Area (m²)',
            type: 'number',
            default: 250,
            unit: 'm²',
          },
        ],
        sql: (p) =>
          `SELECT * FROM land_parcels\nWHERE sl_land_type ILIKE '%Vacant%'\n  AND area >= ${p['min_area']};`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) => {
            const conds: { field: string; operator: string; value: string }[] = [
              { field: 'sl_land_type', operator: '%', value: 'Vacant' },
            ];
            if (Number(p['min_area']) > 0) {
              conds.push({ field: 'area_m2', operator: '>=', value: String(p['min_area']) });
            }
            return conds;
          },
          logic: 'AND',
        },
      },
      {
        id: 'large_parcels',
        name: 'Large Parcels',
        description: 'Find parcels above a given area threshold',
        params: [
          { key: 'min_area', label: 'Min Area (m²)', type: 'number', default: 1000, unit: 'm²' },
        ],
        sql: (p) => `SELECT * FROM land_parcels\nWHERE area >= ${p['min_area']};`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) => [{ field: 'area_m2', operator: '>=', value: String(p['min_area']) }],
        },
      },
    ],
  },
  planning: {
    label: 'Urban Planning',
    icon: 'location_city',
    color: '#3498db',
    queries: [
      {
        id: 'zoning_check',
        name: 'Zoning Compliance Check',
        description: 'Verify if land use conforms to zoning regulations',
        params: [
          {
            key: 'zone_type',
            label: 'Expected Zone',
            type: 'select',
            options: ['Residential', 'Commercial', 'Industrial', 'Conservation', 'Mixed Use'],
          },
        ],
        sql: (p) =>
          `SELECT * FROM land_parcels\nWHERE zoning = '${p['zone_type']}'\n  AND land_use != zoning;`,
        backend: {
          // Runs against la_ls_zoning.zoning_category. The cross-field non-conformance
          // check (land_use != zoning) needs a column-vs-column comparison the current
          // engine does not support, so the backend returns parcels with the selected zone.
          layerIds: [1, 6],
          toConditions: (p) => [{ field: 'zoning', operator: '=', value: String(p['zone_type']) }],
          logic: 'AND',
        },
      },
      {
        id: 'road_widening',
        name: 'Road Widening Impact',
        description: 'Parcels affected by proposed road widening',
        params: [
          { key: 'road', label: 'Road Name', type: 'text', default: '' },
          { key: 'width', label: 'Widening Distance', type: 'number', default: 5, unit: 'm' },
        ],
        sql: (p) =>
          `SELECT p.* FROM land_parcels p\nJOIN road_centerlines r ON\n  ST_DWithin(p.geom, r.geom, ${p['width']})\nWHERE r.road_name ILIKE '%${p['road']}%';`,
      },
      {
        id: 'far_violation',
        name: 'FAR / Coverage Violations',
        description: 'Buildings exceeding floor area ratio or plot coverage',
        params: [
          { key: 'max_far', label: 'Max FAR', type: 'number', default: 2.5 },
          { key: 'max_coverage', label: 'Max Coverage %', type: 'number', default: 65, unit: '%' },
        ],
        sql: (p) =>
          `SELECT b.*, p.assessment_no FROM buildings b\nJOIN land_parcels p ON\n  ST_Within(b.geom, p.geom)\nWHERE b.floor_area_ratio > ${p['max_far']}\n  OR b.plot_coverage > ${p['max_coverage']};`,
        backend: {
          // Runs against la_ls_build_unit.floor_area_ratio / plot_coverage (added in
          // migration 0019). OR logic: a building violates if EITHER threshold is exceeded.
          layerIds: [3, 12],
          toConditions: (p) => [
            { field: 'floor_area_ratio', operator: '>', value: String(p['max_far']) },
            { field: 'plot_coverage', operator: '>', value: String(p['max_coverage']) },
          ],
          logic: 'OR',
        },
      },
    ],
  },
  buildings: {
    label: 'Buildings',
    icon: 'apartment',
    color: '#e67e22',
    queries: [
      {
        id: 'building_search',
        name: 'Building Search by Name',
        description: 'Search buildings by name',
        params: [{ key: 'value', label: 'Search Value', type: 'text', default: '' }],
        sql: (p) => `SELECT * FROM buildings\nWHERE building_name ILIKE '%${p['value']}%';`,
        backend: {
          layerIds: [3, 12],
          toConditions: (p) =>
            p['value']
              ? [{ field: 'building_name', operator: '%', value: String(p['value']) }]
              : [],
        },
      },
      {
        id: 'high_rise',
        name: 'High-Rise Buildings',
        description: 'Find buildings above a given number of floors',
        params: [{ key: 'min_floors', label: 'Min Floors', type: 'number', default: 5 }],
        sql: (p) => `SELECT * FROM buildings\nWHERE no_floors >= ${p['min_floors']};`,
        backend: {
          layerIds: [3, 12],
          toConditions: (p) => [
            { field: 'no_floors', operator: '>=', value: String(p['min_floors']) },
          ],
        },
      },
      {
        id: 'poor_condition',
        name: 'Poor Condition Buildings',
        description: 'Buildings with condition = Poor or Very Poor',
        params: [
          {
            key: 'condition',
            label: 'Condition',
            type: 'select',
            options: ['Poor', 'Very Poor', 'Fair'],
          },
        ],
        sql: (p) => `SELECT * FROM buildings\nWHERE condition ILIKE '%${p['condition']}%';`,
        backend: {
          layerIds: [3, 12],
          toConditions: (p) => [
            { field: 'condition', operator: '%', value: String(p['condition']) },
          ],
        },
      },
      {
        id: 'large_building',
        name: 'Large Buildings by Area',
        description: 'Find buildings above a given floor area',
        params: [
          { key: 'min_area', label: 'Min Area (m²)', type: 'number', default: 500, unit: 'm²' },
        ],
        sql: (p) => `SELECT * FROM buildings\nWHERE area >= ${p['min_area']};`,
        backend: {
          layerIds: [3, 12],
          toConditions: (p) => [{ field: 'area_m2', operator: '>=', value: String(p['min_area']) }],
        },
      },
    ],
  },
  revenue: {
    label: 'Revenue & Tax',
    icon: 'payments',
    color: '#9b59b6',
    queries: [
      {
        id: 'outstanding_rates',
        name: 'Outstanding / Overdue Tax',
        description: 'Parcels and buildings with overdue tax status',
        params: [
          {
            key: 'layer_type',
            label: 'Layer Type',
            type: 'select',
            options: ['Land Parcels', 'Buildings'],
          },
        ],
        sql: () =>
          `SELECT p.su_id, a.tax_status, a.assessment_annual_value\nFROM survey_rep p\nJOIN assessment a ON a.su_id = p.su_id\nWHERE a.tax_status = 'overdue';`,
        backend: {
          layerIds: [1, 6],
          toConditions: () => [{ field: 'tax_status', operator: '=', value: 'overdue' }],
          // Note: layerIds is overridden at runtime based on layer_type param
        },
      },
      {
        id: 'high_market_value',
        name: 'High Market Value Properties',
        description: 'Properties above a market value threshold',
        params: [
          {
            key: 'layer_type',
            label: 'Layer Type',
            type: 'select',
            options: ['Land Parcels', 'Buildings'],
          },
          {
            key: 'min_value',
            label: 'Min Market Value',
            type: 'number',
            default: 1000000,
            unit: 'LKR',
          },
        ],
        sql: (p) =>
          `SELECT p.su_id, a.market_value\nFROM survey_rep p\nJOIN assessment a ON a.su_id = p.su_id\nWHERE a.market_value > ${p['min_value']};`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) => [
            { field: 'market_value', operator: '>=', value: String(p['min_value']) },
          ],
        },
      },
      {
        id: 'low_assessed_value',
        name: 'Low Assessment Value',
        description: 'Properties with assessment value below threshold',
        params: [
          {
            key: 'layer_type',
            label: 'Layer Type',
            type: 'select',
            options: ['Land Parcels', 'Buildings'],
          },
          {
            key: 'max_value',
            label: 'Max Assessed Value',
            type: 'number',
            default: 50000,
            unit: 'LKR',
          },
        ],
        sql: (p) =>
          `SELECT p.su_id, a.assessment_annual_value\nFROM survey_rep p\nJOIN assessment a ON a.su_id = p.su_id\nWHERE a.assessment_annual_value < ${p['max_value']};`,
        backend: {
          layerIds: [1, 6],
          toConditions: (p) => [
            { field: 'assessment_value', operator: '<=', value: String(p['max_value']) },
          ],
        },
      },
    ],
  },
  environment: {
    label: 'Environment & Health',
    icon: 'eco',
    color: '#1abc9c',
    queries: [
      {
        id: 'sensitive_zone',
        name: 'Sensitive Zone Buffer',
        description: 'Parcels within buffer of environmental zones',
        params: [
          {
            key: 'zone_type',
            label: 'Zone Type',
            type: 'select',
            options: ['Wetland', 'Forest Reserve', 'Tank Bund', 'Mangrove', 'Wildlife Corridor'],
          },
          { key: 'buffer', label: 'Buffer Distance', type: 'number', default: 50, unit: 'm' },
        ],
        sql: (p) =>
          `SELECT p.* FROM land_parcels p\nJOIN environmental_zones ez\n  ON ST_DWithin(p.geom, ez.geom, ${p['buffer']})\nWHERE ez.zone_type = '${p['zone_type']}';`,
      },
      {
        id: 'dengue_hotspot',
        name: 'Dengue Hotspot Analysis',
        description: 'Correlate dengue cases with land use patterns',
        params: [
          { key: 'radius', label: 'Cluster Radius', type: 'number', default: 250, unit: 'm' },
          {
            key: 'period',
            label: 'Period',
            type: 'select',
            options: ['Last 30 Days', 'Last 90 Days', 'Last 6 Months', 'Last Year'],
          },
        ],
        sql: (p) => {
          const interval =
            p['period'] === 'Last 30 Days'
              ? '30 days'
              : p['period'] === 'Last 90 Days'
                ? '90 days'
                : p['period'] === 'Last 6 Months'
                  ? '6 months'
                  : '1 year';
          return `SELECT p.land_use,\n  COUNT(d.id) AS cases,\n  p.geom\nFROM dengue_reports d\nJOIN land_parcels p\n  ON ST_DWithin(d.geom, p.geom, ${p['radius']})\nWHERE d.reported_date >= NOW()\n  - INTERVAL '${interval}'\nGROUP BY p.land_use, p.geom;`;
        },
      },
    ],
  },
};
