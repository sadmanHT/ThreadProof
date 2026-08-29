export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      capacity_allocations: {
        Row: {
          capacity_opening_id: string;
          chain_block_number: number | null;
          chain_tx_hash: string | null;
          confirmed_at: string | null;
          created_at: string;
          id: string;
          new_commitment: number;
          nullifier: number;
          old_commitment: number;
          order_commitment: number;
          order_version_id: string;
        };
        Insert: {
          capacity_opening_id: string;
          chain_block_number?: number | null;
          chain_tx_hash?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          id?: string;
          new_commitment: number;
          nullifier: number;
          old_commitment: number;
          order_commitment: number;
          order_version_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["capacity_allocations"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "capacity_allocations_capacity_opening_id_fkey";
            columns: ["capacity_opening_id"];
            isOneToOne: false;
            referencedRelation: "private_capacity_openings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "capacity_allocations_order_version_id_fkey";
            columns: ["order_version_id"];
            isOneToOne: false;
            referencedRelation: "order_versions";
            referencedColumns: ["id"];
          }
        ];
      };
      chain_events: {
        Row: {
          block_hash: string;
          block_number: number;
          chain_id: number;
          contract_address: string;
          data: Json;
          event_name: string;
          id: number;
          indexed_values: Json;
          log_index: number;
          observed_at: string;
          transaction_hash: string;
        };
        Insert: {
          block_hash: string;
          block_number: number;
          chain_id: number;
          contract_address: string;
          data?: Json;
          event_name: string;
          id?: number;
          indexed_values?: Json;
          log_index: number;
          observed_at?: string;
          transaction_hash: string;
        };
        Update: Partial<Database["public"]["Tables"]["chain_events"]["Insert"]>;
        Relationships: [];
      };
      credentials: {
        Row: {
          chain_credential_id: string;
          chain_tx_hash: string | null;
          created_at: string;
          credential_type: string;
          digest: string;
          encrypted_credential: string | null;
          id: string;
          issuer_organization_id: string;
          scope_hash: string;
          status: Database["public"]["Enums"]["credential_status"];
          storage_object_path: string | null;
          subject_organization_id: string;
          valid_from: string;
          valid_until: string;
        };
        Insert: {
          chain_credential_id: string;
          chain_tx_hash?: string | null;
          created_at?: string;
          credential_type: string;
          digest: string;
          encrypted_credential?: string | null;
          id?: string;
          issuer_organization_id: string;
          scope_hash: string;
          status?: Database["public"]["Enums"]["credential_status"];
          storage_object_path?: string | null;
          subject_organization_id: string;
          valid_from: string;
          valid_until: string;
        };
        Update: Partial<Database["public"]["Tables"]["credentials"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "credentials_issuer_organization_id_fkey";
            columns: ["issuer_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "credentials_subject_organization_id_fkey";
            columns: ["subject_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      encrypted_supplier_identities: {
        Row: {
          ciphertext: string;
          created_at: string;
          disclosure_policy_hash: string;
          id: string;
          key_version: number;
          nonce: string;
          organization_id: string;
          pseudonym: string;
        };
        Insert: {
          ciphertext: string;
          created_at?: string;
          disclosure_policy_hash: string;
          id?: string;
          key_version: number;
          nonce: string;
          organization_id: string;
          pseudonym: string;
        };
        Update: Partial<Database["public"]["Tables"]["encrypted_supplier_identities"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "encrypted_supplier_identities_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      governance_proposal_read_model: {
        Row: {
          approvals_received: number;
          approvals_required: number | null;
          chain_proposal_id: string;
          execute_after: string | null;
          executed_tx_hash: string | null;
          last_synced_block: number;
          policy_version: string | null;
          proposal_type: string;
          proposer_chain_organization_id: string;
          state: string;
          updated_at: string;
        };
        Insert: {
          approvals_received?: number;
          approvals_required?: number | null;
          chain_proposal_id: string;
          execute_after?: string | null;
          executed_tx_hash?: string | null;
          last_synced_block: number;
          policy_version?: string | null;
          proposal_type: string;
          proposer_chain_organization_id: string;
          state: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["governance_proposal_read_model"]["Insert"]>;
        Relationships: [];
      };
      order_versions: {
        Row: {
          buyer_signature: string | null;
          confidential_payload_ciphertext: string;
          created_at: string;
          created_by: string;
          id: string;
          order_commitment: string;
          payload_nonce: string;
          policy_hash: string;
          previous_version_hash: string | null;
          production_period_end: string | null;
          production_period_start: string | null;
          purchase_order_id: string;
          version: number;
          workload_commitment: string | null;
        };
        Insert: {
          buyer_signature?: string | null;
          confidential_payload_ciphertext: string;
          created_at?: string;
          created_by: string;
          id?: string;
          order_commitment: string;
          payload_nonce: string;
          policy_hash: string;
          previous_version_hash?: string | null;
          production_period_end?: string | null;
          production_period_start?: string | null;
          purchase_order_id: string;
          version: number;
          workload_commitment?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["order_versions"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "order_versions_purchase_order_id_fkey";
            columns: ["purchase_order_id"];
            isOneToOne: false;
            referencedRelation: "purchase_orders";
            referencedColumns: ["id"];
          }
        ];
      };
      organization_members: {
        Row: {
          active: boolean;
          created_at: string;
          member_role: string;
          organization_id: string;
          user_id: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          member_role: string;
          organization_id: string;
          user_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["organization_members"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      organizations: {
        Row: {
          chain_organization_id: string;
          country_code: string | null;
          created_at: string;
          display_name: string;
          id: string;
          legal_name: string;
          metadata: Json;
          role: Database["public"]["Enums"]["organization_role"];
          status: Database["public"]["Enums"]["organization_status"];
          updated_at: string;
        };
        Insert: {
          chain_organization_id: string;
          country_code?: string | null;
          created_at?: string;
          display_name: string;
          id?: string;
          legal_name: string;
          metadata?: Json;
          role: Database["public"]["Enums"]["organization_role"];
          status?: Database["public"]["Enums"]["organization_status"];
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["organizations"]["Insert"]>;
        Relationships: [];
      };
      private_capacity_openings: {
        Row: {
          capacity_commitment: number;
          capacity_credential_id: string;
          chain_state_key: string;
          circuit_version: number;
          created_at: string;
          encrypted_randomness: string;
          encrypted_remaining_capacity: string;
          encryption_key_version: number;
          factory_organization_id: string;
          id: string;
          last_chain_block: number | null;
          period_id: string;
          policy_hash: string;
          process_id: string;
          status: Database["public"]["Enums"]["capacity_state_status"];
          updated_at: string;
        };
        Insert: {
          capacity_commitment: number;
          capacity_credential_id: string;
          chain_state_key: string;
          circuit_version: number;
          created_at?: string;
          encrypted_randomness: string;
          encrypted_remaining_capacity: string;
          encryption_key_version?: number;
          factory_organization_id: string;
          id?: string;
          last_chain_block?: number | null;
          period_id: string;
          policy_hash: string;
          process_id: string;
          status?: Database["public"]["Enums"]["capacity_state_status"];
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["private_capacity_openings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "private_capacity_openings_capacity_credential_id_fkey";
            columns: ["capacity_credential_id"];
            isOneToOne: false;
            referencedRelation: "credentials";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "private_capacity_openings_factory_organization_id_fkey";
            columns: ["factory_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      proof_jobs: {
        Row: {
          capacity_opening_id: string;
          circuit_version: number;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          error_detail: string | null;
          factory_organization_id: string;
          id: string;
          order_version_id: string;
          proof: Json | null;
          public_inputs: Json;
          started_at: string | null;
          status: Database["public"]["Enums"]["proof_job_status"];
        };
        Insert: {
          capacity_opening_id: string;
          circuit_version: number;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          error_detail?: string | null;
          factory_organization_id: string;
          id?: string;
          order_version_id: string;
          proof?: Json | null;
          public_inputs?: Json;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["proof_job_status"];
        };
        Update: Partial<Database["public"]["Tables"]["proof_jobs"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "proof_jobs_capacity_opening_id_fkey";
            columns: ["capacity_opening_id"];
            isOneToOne: false;
            referencedRelation: "private_capacity_openings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "proof_jobs_factory_organization_id_fkey";
            columns: ["factory_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "proof_jobs_order_version_id_fkey";
            columns: ["order_version_id"];
            isOneToOne: false;
            referencedRelation: "order_versions";
            referencedColumns: ["id"];
          }
        ];
      };
      purchase_orders: {
        Row: {
          buyer_organization_id: string;
          created_at: string;
          created_by: string;
          current_order_commitment: string | null;
          current_policy_hash: string | null;
          current_version: number;
          external_reference: string;
          id: string;
          status: Database["public"]["Enums"]["order_status"];
          updated_at: string;
        };
        Insert: {
          buyer_organization_id: string;
          created_at?: string;
          created_by: string;
          current_order_commitment?: string | null;
          current_policy_hash?: string | null;
          current_version?: number;
          external_reference: string;
          id?: string;
          status?: Database["public"]["Enums"]["order_status"];
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["purchase_orders"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "purchase_orders_buyer_organization_id_fkey";
            columns: ["buyer_organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      capacity_state_status:
        | "active"
        | "pending_spend"
        | "superseded"
        | "recertification_required";
      credential_status: "active" | "suspended" | "revoked" | "expired";
      order_status:
        | "draft"
        | "proposed"
        | "feasible"
        | "infeasible"
        | "accepted"
        | "cancelled"
        | "completed";
      organization_role:
        | "buyer"
        | "factory"
        | "auditor"
        | "regulator"
        | "industry"
        | "labor_representative"
        | "independent";
      organization_status: "active" | "suspended" | "revoked";
      proof_job_status:
        | "queued"
        | "generating"
        | "generated"
        | "submitted"
        | "confirmed"
        | "failed"
        | "stale";
    };
    CompositeTypes: { [_ in never]: never };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;
type DefaultSchema = DatabaseWithoutInternals["public"];

export type Tables<
  TableName extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"]),
> = (DefaultSchema["Tables"] & DefaultSchema["Views"])[TableName] extends {
  Row: infer R;
}
  ? R
  : never;

export type TablesInsert<TableName extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][TableName] extends { Insert: infer I } ? I : never;

export type TablesUpdate<TableName extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][TableName] extends { Update: infer U } ? U : never;

export type Enums<EnumName extends keyof DefaultSchema["Enums"]> =
  DefaultSchema["Enums"][EnumName];

export const Constants = {
  public: {
    Enums: {
      capacity_state_status: [
        "active",
        "pending_spend",
        "superseded",
        "recertification_required",
      ],
      credential_status: ["active", "suspended", "revoked", "expired"],
      order_status: [
        "draft",
        "proposed",
        "feasible",
        "infeasible",
        "accepted",
        "cancelled",
        "completed",
      ],
      organization_role: [
        "buyer",
        "factory",
        "auditor",
        "regulator",
        "industry",
        "labor_representative",
        "independent",
      ],
      organization_status: ["active", "suspended", "revoked"],
      proof_job_status: [
        "queued",
        "generating",
        "generated",
        "submitted",
        "confirmed",
        "failed",
        "stale",
      ],
    },
  },
} as const;
