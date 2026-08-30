export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  __InternalSupabase: { PostgrestVersion: "14.5" };
  public: {
    Tables: {
      capacity_allocations: Table<{
        capacity_opening_id: string;
        chain_block_number: number | null;
        chain_tx_hash: string | null;
        confirmed_at: string | null;
        created_at: string;
        id: string;
        new_commitment: string;
        nullifier: string;
        old_commitment: string;
        order_commitment: string;
        order_version_id: string;
      }>;
      capacity_certification_jobs: Table<{
        assessment_methodology: string;
        auditor_organization_id: string;
        capacity_commitment: string;
        certification_block_number: number | null;
        certification_tx_hash: string | null;
        chain_credential_id: string;
        chain_period_id: string;
        chain_process_id: string;
        circuit_version: number;
        created_at: string;
        created_by: string;
        credential_block_number: number | null;
        credential_digest: string;
        credential_scope_hash: string;
        credential_tx_hash: string | null;
        encrypted_capacity: string;
        encrypted_randomness: string;
        encryption_key_version: number;
        error_code: string | null;
        error_detail: string | null;
        factory_organization_id: string;
        id: string;
        period_label: string;
        policy_hash: string;
        process_label: string;
        status: string;
        updated_at: string;
        valid_from: string;
        valid_until: string;
      }>;
      chain_events: Table<{
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
      }>;
      credentials: Table<{
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
      }>;
      encrypted_supplier_identities: Table<{
        ciphertext: string;
        created_at: string;
        disclosure_policy_hash: string;
        id: string;
        key_version: number;
        nonce: string;
        organization_id: string;
        pseudonym: string;
      }>;
      governance_proposal_read_model: Table<{
        action_hash: string | null;
        approval_mask: number;
        approvals_received: number;
        approvals_required: number | null;
        approved_at: string | null;
        cancelled_at: string | null;
        chain_proposal_id: string;
        execute_after: string | null;
        executed_at: string | null;
        executed_tx_hash: string | null;
        expires_at: string | null;
        last_synced_block: number;
        metadata_hash: string | null;
        policy_version: string | null;
        proposal_type: string;
        proposer_chain_organization_id: string;
        state: string;
        updated_at: string;
      }>;
      order_authorization_jobs: Table<{
        buyer_organization_id: string;
        buyer_signature: string | null;
        chain_block_number: number | null;
        chain_order_id: string;
        chain_tx_hash: string | null;
        confidential_payload_ciphertext: string;
        created_at: string;
        created_by: string;
        deadline: string;
        error_code: string | null;
        error_detail: string | null;
        factory_organization_id: string;
        id: string;
        nonce: string;
        order_commitment: string;
        payload_nonce: string;
        policy_hash: string;
        previous_version_hash: string;
        production_period_end: string | null;
        production_period_start: string | null;
        purchase_order_id: string;
        status: string;
        target_version: number;
        updated_at: string;
        worker_claim_token: string | null;
        worker_claimed_at: string | null;
      }>;
      order_versions: Table<{
        buyer_signature: string | null;
        chain_block_number: number | null;
        chain_tx_hash: string | null;
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
        version_hash: string | null;
        workload_commitment: string | null;
      }>;
      organization_invitations: Table<{
        accepted_at: string | null;
        created_at: string;
        email: string;
        expires_at: string;
        id: string;
        invited_by: string;
        member_role: string;
        organization_id: string;
        token_hash: string;
      }>;
      organization_members: Table<{
        active: boolean;
        created_at: string;
        member_role: string;
        organization_id: string;
        user_id: string;
      }>;
      organization_onboarding_requests: Table<{
        action_hash: string | null;
        chain_proposal_id: string | null;
        chain_registration_block_number: number | null;
        chain_registration_tx_hash: string | null;
        country_code: string | null;
        created_at: string;
        display_name: string;
        id: string;
        legal_name: string;
        metadata_hash: string | null;
        notes: string | null;
        primary_account: string | null;
        proposed_chain_organization_id: string | null;
        requested_by: string;
        requested_role: Database["public"]["Enums"]["organization_role"];
        reviewed_at: string | null;
        status: string;
        wallet_signature: string | null;
      }>;
      organizations: Table<{
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
      }>;
      private_capacity_openings: Table<{
        capacity_commitment: string;
        capacity_credential_id: string;
        chain_period_id: string | null;
        chain_process_id: string | null;
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
      }>;
      profiles: Table<{
        created_at: string;
        display_name: string | null;
        email: string;
        id: string;
        job_title: string | null;
        updated_at: string;
      }>;
      proof_job_private_state: Table<{
        created_at: string;
        next_capacity_ciphertext: string;
        next_randomness_ciphertext: string;
        proof_job_id: string;
      }>;
      proof_jobs: Table<{
        capacity_opening_id: string;
        chain_block_number: number | null;
        chain_tx_hash: string | null;
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
        worker_claim_token: string | null;
        worker_claimed_at: string | null;
      }>;
      purchase_orders: Table<{
        buyer_organization_id: string;
        chain_order_id: string;
        created_at: string;
        created_by: string;
        current_order_commitment: string | null;
        current_policy_hash: string | null;
        current_version: number;
        external_reference: string;
        factory_organization_id: string | null;
        id: string;
        product_category: string | null;
        quantity: number | null;
        requested_delivery_date: string | null;
        status: Database["public"]["Enums"]["order_status"];
        title: string | null;
        unit: string | null;
        updated_at: string;
      }>;
      verifier_provenance_read_model: Table<{
        chain_id: number;
        circuit_artifact_hash: string;
        circuit_version: number;
        contract_address: string;
        observed_at: string;
        registered_block: number;
        registration_tx_hash: string;
        verification_key_hash: string;
        verifier_address: string;
        verifier_code_hash: string;
      }>;
    };
    Views: { [_ in never]: never };
    Functions: {
      accept_organization_invitation: { Args: { invite_token: string }; Returns: string };
      create_organization_invitation: {
        Args: { expires_in_hours?: number; invite_email: string; invite_member_role?: string; target_organization_id: string };
        Returns: { expires_at: string; invitation_id: string; invite_token: string }[];
      };
      create_purchase_order_draft: {
        Args: { buyer_organization_id: string; external_reference: string; factory_organization_id: string; product_category: string; quantity: number; requested_delivery_date?: string; title: string; unit: string };
        Returns: string;
      };
      delete_purchase_order_draft: { Args: { target_order_id: string }; Returns: undefined };
      queue_capacity_proof: { Args: { target_capacity_opening_id: string; target_order_version_id: string }; Returns: string };
      update_purchase_order_draft: {
        Args: { new_external_reference: string; new_product_category: string; new_quantity: number; new_requested_delivery_date?: string; new_title: string; new_unit: string; target_order_id: string };
        Returns: undefined };
    };
    Enums: {
      capacity_state_status: "active" | "pending_spend" | "superseded" | "recertification_required";
      credential_status: "active" | "suspended" | "revoked" | "expired";
      order_status: "draft" | "proposed" | "feasible" | "infeasible" | "accepted" | "cancelled" | "completed";
      organization_role: "buyer" | "factory" | "auditor" | "regulator" | "industry" | "labor_representative" | "independent";
      organization_status: "active" | "suspended" | "revoked";
      proof_job_status: "queued" | "generating" | "generated" | "submitted" | "confirmed" | "failed" | "stale";
    };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type Enums<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T];
